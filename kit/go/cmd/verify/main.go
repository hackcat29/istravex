// Command verify checks every fixture's provenance:
//
//  1. manifest.json validates against corpus/manifest.schema.json
//  2. each file's sha256 and size match the manifest
//  3. the canonical LedgerCloseMeta for the fixture's ledger (corpus/ledgers)
//     matches its recorded sha256, and its header protocol matches the manifest
//  4. the fixture's transaction is found in that ledger by hash, and every XDR
//     value in the fixture is byte-identical to the ledger's copy (a file
//     listed under source.related comes from that other transaction)
//
// Synthetic fixtures have no ledger; only checks 1 and 2 apply.
//
// It writes corpus/results/provenance.json and exits non-zero on any failure.
//
//	go run ./cmd/verify ../../corpus
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/klauspost/compress/zstd"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stellar/go-stellar-sdk/ingest"
	"github.com/stellar/go-stellar-sdk/network"
	"github.com/stellar/go-stellar-sdk/xdr"
)

type file struct {
	Name    string `json:"name"`
	XdrType string `json:"xdr_type"`
	Path    string `json:"path"`
	Sha256  string `json:"sha256"`
	Bytes   int    `json:"bytes"`
}

type txRef struct {
	Ledger uint32   `json:"ledger"`
	TxHash string   `json:"tx_hash"`
	Files  []string `json:"files"`
}

type manifest struct {
	ID              string `json:"id"`
	Network         string `json:"network"`
	ProtocolVersion uint32 `json:"protocol_version"`
	Synthetic       bool   `json:"synthetic"`
	Source          struct {
		Ledger    uint32  `json:"ledger"`
		TxHash    string  `json:"tx_hash"`
		Related   []txRef `json:"related"`
		Generator *struct {
			NetworkPassphrase string `json:"network_passphrase"`
		} `json:"generator"`
	} `json:"source"`
	ExpectedDecoded map[string]any `json:"expected_decoded"`
	Files           []file         `json:"files"`
}

type ledgerIndex struct {
	Network string `json:"network"`
	Ledger  uint32 `json:"ledger"`
	Path    string `json:"path"`
	Sha256  string `json:"sha256"`
	Source  string `json:"source"`
}

type check struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
}

type report struct {
	Fixture string  `json:"fixture"`
	Ledger  string  `json:"ledger_source"`
	Checks  []check `json:"checks"`
}

var passphrase = map[string]string{"pubnet": network.PublicNetworkPassphrase, "testnet": network.TestNetworkPassphrase, "local": "Standalone Network ; February 2017"}

func digest(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func readLedger(corpus string, li ledgerIndex) (xdr.LedgerCloseMeta, error) {
	var lcm xdr.LedgerCloseMeta
	f, err := os.Open(filepath.Join(corpus, li.Path))
	if err != nil {
		return lcm, err
	}
	defer f.Close()
	dec, err := zstd.NewReader(f)
	if err != nil {
		return lcm, err
	}
	defer dec.Close()
	raw, err := io.ReadAll(dec)
	if err != nil {
		return lcm, err
	}
	if got := digest(raw); got != li.Sha256 {
		return lcm, fmt.Errorf("ledger sha256 %s, index says %s", got, li.Sha256)
	}
	var batch xdr.LedgerCloseMetaBatch
	if err := batch.UnmarshalBinary(raw); err != nil {
		return lcm, err
	}
	for _, m := range batch.LedgerCloseMetas {
		if m.LedgerSequence() == li.Ledger {
			return m, nil
		}
	}
	return lcm, fmt.Errorf("ledger %d not in batch", li.Ledger)
}

func findTx(pp string, lcm xdr.LedgerCloseMeta, hash string) (ingest.LedgerTransaction, error) {
	r, err := ingest.NewLedgerTransactionReaderFromLedgerCloseMeta(pp, lcm)
	if err != nil {
		return ingest.LedgerTransaction{}, err
	}
	defer r.Close()
	for {
		tx, err := r.Read()
		if errors.Is(err, io.EOF) {
			return tx, fmt.Errorf("tx %s not in ledger", hash)
		}
		if err != nil {
			return tx, err
		}
		if tx.Hash.HexString() == hash {
			return tx, nil
		}
	}
}

// ledgerCopy returns the ledger's own encoding of the value a fixture file holds.
func ledgerCopy(f file, fixtureBytes []byte, tx ingest.LedgerTransaction) ([]byte, error) {
	switch f.XdrType {
	case "TransactionEnvelope":
		return tx.Envelope.MarshalBinary()
	case "TransactionResult":
		return tx.Result.Result.MarshalBinary()
	case "TransactionMeta":
		return tx.UnsafeMeta.MarshalBinary()
	case "LedgerEntryChanges":
		return tx.FeeChanges.MarshalBinary()
	case "LedgerEntryData":
		// The entry, as the transaction left it: the last change to the same
		// ledger key (changes are in apply order).
		var data xdr.LedgerEntryData
		if err := data.UnmarshalBinary(fixtureBytes); err != nil {
			return nil, err
		}
		key, err := (&xdr.LedgerEntry{Data: data}).LedgerKey()
		if err != nil {
			return nil, err
		}
		want, _ := key.MarshalBinary()
		changes, err := tx.GetChanges()
		if err != nil {
			return nil, err
		}
		var last *xdr.LedgerEntry
		for _, c := range changes {
			if c.Post == nil {
				continue
			}
			k, err := c.Post.LedgerKey()
			if err != nil {
				continue
			}
			if got, _ := k.MarshalBinary(); bytes.Equal(got, want) {
				last = c.Post
			}
		}
		if last == nil {
			return nil, fmt.Errorf("entry not changed by tx %s", tx.Hash.HexString())
		}
		return last.Data.MarshalBinary()
	}
	return nil, fmt.Errorf("no ledger source for %s", f.XdrType)
}

// equalWithoutDiagnostics compares two TransactionMeta values with their
// node-local diagnostic events removed (they are not part of consensus).
func equalWithoutDiagnostics(a, b []byte) bool {
	strip := func(raw []byte) []byte {
		var m xdr.TransactionMeta
		if m.UnmarshalBinary(raw) != nil {
			return nil
		}
		switch {
		case m.V4 != nil:
			m.V4.DiagnosticEvents = nil
		case m.V3 != nil && m.V3.SorobanMeta != nil:
			m.V3.SorobanMeta.DiagnosticEvents = nil
		}
		out, _ := m.MarshalBinary()
		return out
	}
	x, y := strip(a), strip(b)
	return x != nil && bytes.Equal(x, y)
}

func verify(corpus string, schema *jsonschema.Schema, dir string, ledgers map[string]ledgerIndex) report {
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	rep := report{Fixture: filepath.Base(dir)}
	add := func(name string, err error) bool {
		c := check{Name: name, OK: err == nil}
		if err != nil {
			c.Detail = err.Error()
		}
		rep.Checks = append(rep.Checks, c)
		return err == nil
	}
	if !add("manifest readable", err) {
		return rep
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err == nil {
		err = schema.Validate(inst)
	}
	add("manifest schema", err)

	var m manifest
	if !add("manifest decode", json.Unmarshal(raw, &m)) {
		return rep
	}
	rep.Fixture = m.ID
	blobs := map[string][]byte{}
	for _, f := range m.Files {
		b64, err := os.ReadFile(filepath.Join(dir, f.Path))
		var bin []byte
		if err == nil {
			bin, err = base64.StdEncoding.DecodeString(strings.TrimSpace(string(b64)))
		}
		if err == nil && (digest(bin) != f.Sha256 || len(bin) != f.Bytes) {
			err = fmt.Errorf("sha256/size mismatch: got %s/%d", digest(bin), len(bin))
		}
		add("sha256 "+f.Name, err)
		blobs[f.Name] = bin
	}

	if m.Synthetic {
		rep.Ledger = "synthetic: no ledger"
		return rep
	}
	pp := passphrase[m.Network]
	if m.Source.Generator != nil && m.Source.Generator.NetworkPassphrase != "" {
		pp = m.Source.Generator.NetworkPassphrase
	}
	// A whole-ledger fixture: its LedgerCloseMeta must be the canonical ledger's.
	if m.Source.TxHash == "" {
		li, ok := ledgers[fmt.Sprintf("%s/%d", m.Network, m.Source.Ledger)]
		if !ok {
			add("canonical ledger present", fmt.Errorf("no corpus/ledgers entry for %s/%d", m.Network, m.Source.Ledger))
			return rep
		}
		rep.Ledger = li.Source
		lcm, err := readLedger(corpus, li)
		if !add(fmt.Sprintf("canonical ledger sha256 (%d)", m.Source.Ledger), err) {
			return rep
		}
		var perr error
		if v := lcm.ProtocolVersion(); v != m.ProtocolVersion {
			perr = fmt.Errorf("header says protocol %d, manifest %d", v, m.ProtocolVersion)
		}
		add(fmt.Sprintf("protocol_version matches ledger header (%d)", m.Source.Ledger), perr)
		want, err := lcm.MarshalBinary()
		for _, f := range m.Files {
			ferr := err
			if f.XdrType != "LedgerCloseMeta" {
				ferr = fmt.Errorf("a whole-ledger fixture holds only LedgerCloseMeta, not %s", f.XdrType)
			} else if ferr == nil && !bytes.Equal(want, blobs[f.Name]) {
				ferr = fmt.Errorf("bytes differ from ledger (%d vs %d B)", len(blobs[f.Name]), len(want))
			}
			add("matches ledger: "+f.Name, ferr)
		}
		return rep
	}
	// The primary transaction, then any related ones, each from its ledger.
	refs := append([]txRef{{Ledger: m.Source.Ledger, TxHash: m.Source.TxHash}}, m.Source.Related...)
	txOf := map[string]ingest.LedgerTransaction{}
	var primary ingest.LedgerTransaction
	for i, ref := range refs {
		li, ok := ledgers[fmt.Sprintf("%s/%d", m.Network, ref.Ledger)]
		if !ok {
			add("canonical ledger present", fmt.Errorf("no corpus/ledgers entry for %s/%d", m.Network, ref.Ledger))
			return rep
		}
		if i == 0 {
			rep.Ledger = li.Source
		}
		lcm, err := readLedger(corpus, li)
		if !add(fmt.Sprintf("canonical ledger sha256 (%d)", ref.Ledger), err) {
			return rep
		}
		var perr error
		if v := lcm.ProtocolVersion(); v != m.ProtocolVersion {
			perr = fmt.Errorf("header says protocol %d, manifest %d", v, m.ProtocolVersion)
		}
		add(fmt.Sprintf("protocol_version matches ledger header (%d)", ref.Ledger), perr)
		tx, err := findTx(pp, lcm, ref.TxHash)
		if !add("transaction in ledger: "+ref.TxHash[:12], err) {
			return rep
		}
		if i == 0 {
			primary = tx
		}
		for _, name := range ref.Files {
			txOf[name] = tx
		}
	}
	for _, f := range m.Files {
		tx, ok := txOf[f.Name]
		if !ok {
			tx = primary
		}
		want, err := ledgerCopy(f, blobs[f.Name], tx)
		if err == nil && !bytes.Equal(want, blobs[f.Name]) {
			err = fmt.Errorf("bytes differ from ledger (%d vs %d B)", len(blobs[f.Name]), len(want))
			if f.XdrType == "TransactionMeta" && equalWithoutDiagnostics(want, blobs[f.Name]) {
				err = fmt.Errorf("differs only in node-local diagnostic events; re-source meta from the ledger (kit/capture/canonicalize.mjs)")
			}
		}
		add("matches ledger: "+f.Name, err)
	}
	return rep
}

func main() {
	corpus := "../../corpus"
	if len(os.Args) > 1 {
		corpus = os.Args[1]
	}
	c := jsonschema.NewCompiler()
	schema, err := c.Compile(filepath.Join(corpus, "manifest.schema.json"))
	if err != nil {
		panic(err)
	}
	var idx []ledgerIndex
	raw, err := os.ReadFile(filepath.Join(corpus, "ledgers", "index.json"))
	if err != nil {
		panic(err)
	}
	if err := json.Unmarshal(raw, &idx); err != nil {
		panic(err)
	}
	ledgers := map[string]ledgerIndex{}
	for _, l := range idx {
		ledgers[fmt.Sprintf("%s/%d", l.Network, l.Ledger)] = l
	}

	// The findings report validates against its schema too (the committed
	// corpus has one; a generated copy doesn't).
	if _, err := os.Stat(filepath.Join(corpus, "findings.json")); err != nil {
		fmt.Println("--   no findings.json in this corpus")
	} else if fs, err := c.Compile(filepath.Join(corpus, "findings.schema.json")); err != nil {
		panic(err)
	} else if raw, err := os.ReadFile(filepath.Join(corpus, "findings.json")); err != nil {
		panic(err)
	} else if inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw)); err != nil {
		panic(err)
	} else if err := fs.Validate(inst); err != nil {
		fmt.Printf("FAIL findings.json: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("ok   findings.json matches findings.schema.json")

	dirs, _ := filepath.Glob(filepath.Join(corpus, "fixtures", "*"))
	sort.Strings(dirs)
	var reports []report
	failed := 0
	for _, d := range dirs {
		r := verify(corpus, schema, d, ledgers)
		bad := []string{}
		for _, c := range r.Checks {
			if !c.OK {
				bad = append(bad, c.Name+": "+c.Detail)
			}
		}
		status := "ok"
		if len(bad) > 0 {
			status, failed = "FAIL", failed+1
		}
		fmt.Printf("%-4s %-42s %d checks %s\n", status, r.Fixture, len(r.Checks), strings.Join(bad, "; "))
		reports = append(reports, r)
	}
	out, _ := json.MarshalIndent(map[string]any{"fixtures": reports}, "", "  ")
	if err := os.WriteFile(filepath.Join(corpus, "results", "provenance.json"), append(out, '\n'), 0o644); err != nil {
		panic(err)
	}
	if failed > 0 {
		os.Exit(1)
	}
}
