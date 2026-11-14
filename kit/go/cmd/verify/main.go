// Command verify checks every fixture's provenance:
//
//  1. manifest.json validates against corpus/manifest.schema.json
//  2. each file's sha256 and size match the manifest
//  3. the canonical LedgerCloseMeta for the fixture's ledger (corpus/ledgers)
//     matches its recorded sha256, and its header protocol matches the manifest
//  4. the fixture's transaction is found in that ledger by hash, and every XDR
//     value in the fixture is byte-identical to the ledger's copy
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

type manifest struct {
	ID              string `json:"id"`
	Network         string `json:"network"`
	ProtocolVersion uint32 `json:"protocol_version"`
	Source          struct {
		Ledger uint32 `json:"ledger"`
		TxHash string `json:"tx_hash"`
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

var passphrase = map[string]string{"pubnet": network.PublicNetworkPassphrase, "testnet": network.TestNetworkPassphrase}

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
func ledgerCopy(f file, m manifest, tx ingest.LedgerTransaction) ([]byte, error) {
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
		// The account entry as the transaction left it.
		account, _ := m.ExpectedDecoded["account"].(string)
		changes, err := tx.GetChanges()
		if err != nil {
			return nil, err
		}
		// Changes are in apply order; the last one is the state the tx left.
		var last *xdr.LedgerEntry
		for _, c := range changes {
			if c.Type == xdr.LedgerEntryTypeAccount && c.Post != nil && c.Post.Data.MustAccount().AccountId.Address() == account {
				last = c.Post
			}
		}
		if last == nil {
			return nil, fmt.Errorf("account %s not changed in tx", account)
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

	li, ok := ledgers[fmt.Sprintf("%s/%d", m.Network, m.Source.Ledger)]
	if !ok {
		add("canonical ledger present", fmt.Errorf("no corpus/ledgers entry for %s/%d", m.Network, m.Source.Ledger))
		return rep
	}
	rep.Ledger = li.Source
	lcm, err := readLedger(corpus, li)
	if !add("canonical ledger sha256", err) {
		return rep
	}
	var perr error
	if v := lcm.ProtocolVersion(); v != m.ProtocolVersion {
		perr = fmt.Errorf("header says protocol %d, manifest %d", v, m.ProtocolVersion)
	}
	add("protocol_version matches ledger header", perr)

	tx, err := findTx(passphrase[m.Network], lcm, m.Source.TxHash)
	if !add("transaction in ledger", err) {
		return rep
	}
	for _, f := range m.Files {
		want, err := ledgerCopy(f, m, tx)
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
