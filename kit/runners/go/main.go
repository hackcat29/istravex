// Go conformance runner (github.com/stellar/go-stellar-sdk).
// Checks per fixture: decode, byte-exact re-encode, and a high-level
// ("native") conversion compared against the fixture's expected values.
//
//	go run . ../../../corpus
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"

	"github.com/stellar/go-stellar-sdk/amount"
	"github.com/stellar/go-stellar-sdk/network"
	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/xdr"
)

type file struct {
	Name    string `json:"name"`
	XdrType string `json:"xdr_type"`
	Path    string `json:"path"`
}

type manifest struct {
	ID              string            `json:"id"`
	CapIDs          []string          `json:"cap_ids"`
	Network         string            `json:"network"`
	ExpectedDecoded map[string]any    `json:"expected_decoded"`
	ExpectedIndexed map[string]any    `json:"expected_indexed"`
	Files           []file            `json:"files"`
	blobs           map[string]string `json:"-"`
}

type result struct {
	Fixture string            `json:"fixture"`
	Checks  map[string]string `json:"checks"`
	Detail  []string          `json:"detail"`
}

var passphrase = map[string]string{"pubnet": network.PublicNetworkPassphrase, "testnet": network.TestNetworkPassphrase}

func newValue(t string) (any, error) {
	switch t {
	case "TransactionEnvelope":
		return &xdr.TransactionEnvelope{}, nil
	case "TransactionResult":
		return &xdr.TransactionResult{}, nil
	case "TransactionMeta":
		return &xdr.TransactionMeta{}, nil
	case "LedgerEntryData":
		return &xdr.LedgerEntryData{}, nil
	case "LedgerEntryChanges":
		return &xdr.LedgerEntryChanges{}, nil
	}
	return nil, fmt.Errorf("unknown xdr type %s", t)
}

func str(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	}
	return fmt.Sprint(v)
}

type row struct{ field, want, got string }

func nativeChecks(m manifest, dec map[string]any) ([]row, error) {
	e, ix := m.ExpectedDecoded, m.ExpectedIndexed
	switch m.CapIDs[0] {
	case "CAP-0027":
		env := dec["envelope"].(*xdr.TransactionEnvelope)
		i, _ := strconv.Atoi(str(e["op_index"]))
		pay := env.Operations()[i].Body.MustPaymentOp()
		dest := pay.Destination
		addr, err := dest.GetAddress()
		if err != nil {
			return nil, err
		}
		id, err := dest.GetId()
		if err != nil {
			return nil, err
		}
		acc := dest.ToAccountId()
		return []row{
			{"destination_muxed", str(e["destination_muxed"]), addr},
			{"muxed_id", str(e["muxed_id"]), strconv.FormatUint(id, 10)},
			{"destination_account", str(e["destination_account"]), acc.Address()},
			{"asset", str(e["asset"]), pay.Asset.StringCanonical()},
			{"amount", str(e["amount"]), amount.String(pay.Amount)},
		}, nil
	case "CAP-0015":
		env := dec["envelope"].(*xdr.TransactionEnvelope)
		pp := passphrase[m.Network]
		h, err := network.HashTransactionInEnvelope(*env, pp)
		if err != nil {
			return nil, err
		}
		inner := xdr.TransactionEnvelope{Type: xdr.EnvelopeTypeEnvelopeTypeTx, V1: env.FeeBump.Tx.InnerTx.V1}
		ih, err := network.HashTransactionInEnvelope(inner, pp)
		if err != nil {
			return nil, err
		}
		fee := env.FeeBumpAccount().ToAccountId()
		src := env.SourceAccount().ToAccountId()
		return []row{
			{"tx_hash", str(e["tx_hash"]), hex.EncodeToString(h[:])},
			{"inner_tx_hash", str(e["inner_tx_hash"]), hex.EncodeToString(ih[:])},
			{"fee_source", str(e["fee_source"]), fee.Address()},
			{"inner_source", str(e["inner_source"]), src.Address()},
		}, nil
	case "CAP-0040":
		data := dec["ledger_entry"].(*xdr.LedgerEntryData)
		s := data.MustAccount().Signers[0]
		sp := s.Key.MustEd25519SignedPayload()
		p, err := s.Key.GetAddress()
		if err != nil {
			return nil, err
		}
		g, err := strkey.Encode(strkey.VersionByteAccountID, sp.Ed25519[:])
		if err != nil {
			return nil, err
		}
		return []row{
			{"signer_strkey", str(e["signer_strkey"]), p},
			{"signer_ed25519", str(e["signer_ed25519"]), g},
			{"payload_hex", str(e["payload_hex"]), hex.EncodeToString(sp.Payload)},
			{"weight", str(e["weight"]), strconv.Itoa(int(s.Weight))},
		}, nil
	case "CAP-0073":
		meta := dec["meta"].(*xdr.TransactionMeta)
		var created []xdr.TrustLineEntry
		var ops []xdr.OperationMetaV2
		if meta.V4 != nil {
			ops = meta.V4.Operations
		}
		for _, op := range ops {
			for _, c := range op.Changes {
				if c.Type == xdr.LedgerEntryChangeTypeLedgerEntryCreated && c.Created.Data.Type == xdr.LedgerEntryTypeTrustline {
					created = append(created, *c.Created.Data.TrustLine)
				}
			}
		}
		rows := []row{{"trustline_created", "true", strconv.FormatBool(len(created) == 1)}}
		if len(created) > 0 {
			tl := created[0]
			rows = append(rows,
				row{"account", str(ix["account"]), tl.AccountId.Address()},
				row{"asset", str(ix["asset"]), tl.Asset.ToAsset().StringCanonical()},
				row{"limit", str(ix["limit"]), strconv.FormatInt(int64(tl.Limit), 10)},
			)
		}
		return rows, nil
	}
	return nil, fmt.Errorf("no native check for %s", m.CapIDs[0])
}

func run(m manifest) result {
	r := result{Fixture: m.ID, Checks: map[string]string{"decode": "fail", "reencode": "fail", "native": "fail"}, Detail: []string{}}
	dec := map[string]any{}
	for _, f := range m.Files {
		v, err := newValue(f.XdrType)
		if err == nil {
			err = xdr.SafeUnmarshalBase64(m.blobs[f.Name], v)
		}
		if err != nil {
			r.Detail = append(r.Detail, fmt.Sprintf("decode %s: %v", f.Name, err))
			return r
		}
		dec[f.Name] = v
	}
	r.Checks["decode"] = "pass"
	r.Checks["reencode"] = "pass"
	for _, f := range m.Files {
		out, err := xdr.MarshalBase64(dec[f.Name])
		if err != nil || out != m.blobs[f.Name] {
			r.Checks["reencode"] = "fail"
			r.Detail = append(r.Detail, "re-encode differs: "+f.Name)
		}
	}
	rows, err := nativeChecks(m, dec)
	if err != nil {
		r.Detail = append(r.Detail, err.Error())
		return r
	}
	r.Checks["native"] = "pass"
	for _, x := range rows {
		if x.want != x.got {
			r.Checks["native"] = "fail"
			r.Detail = append(r.Detail, fmt.Sprintf("%s: expected %s, got %s", x.field, x.want, x.got))
		}
	}
	return r
}

func main() {
	corpus := "../../../corpus"
	if len(os.Args) > 1 {
		corpus = os.Args[1]
	}
	dirs, _ := filepath.Glob(filepath.Join(corpus, "fixtures", "*", "manifest.json"))
	sort.Strings(dirs)
	results := []result{}
	for _, mf := range dirs {
		raw, err := os.ReadFile(mf)
		if err != nil {
			panic(err)
		}
		var m manifest
		if err := json.Unmarshal(raw, &m); err != nil {
			panic(err)
		}
		m.blobs = map[string]string{}
		for _, f := range m.Files {
			b, err := os.ReadFile(filepath.Join(filepath.Dir(mf), f.Path))
			if err != nil {
				panic(err)
			}
			m.blobs[f.Name] = strings.TrimSpace(string(b))
		}
		r := run(m)
		fmt.Printf("%-42s %v %s\n", r.Fixture, r.Checks, strings.Join(r.Detail, "; "))
		results = append(results, r)
	}
	version := "unknown"
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			if d.Path == "github.com/stellar/go-stellar-sdk" {
				version = strings.TrimPrefix(d.Version, "v")
			}
		}
	}
	out, _ := json.MarshalIndent(map[string]any{
		"sdk": "go", "package": "github.com/stellar/go-stellar-sdk", "version": version,
		"runtime": runtime.Version(), "results": results,
	}, "", "  ")
	if err := os.WriteFile(filepath.Join(corpus, "results", "go.json"), append(out, '\n'), 0o644); err != nil {
		panic(err)
	}
}
