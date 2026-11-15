// Go conformance runner (github.com/stellar/go-stellar-sdk).
// Checks per fixture: decode, byte-exact re-encode, and a high-level
// ("native") conversion compared against the fixture's expected values.
//
//	go run ./cmd/conformance ../../corpus
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
	Expect  string `json:"expect"`
}

type manifest struct {
	ID              string         `json:"id"`
	Pattern         string         `json:"pattern"`
	CapIDs          []string       `json:"cap_ids"`
	Network         string         `json:"network"`
	ExpectedDecoded map[string]any `json:"expected_decoded"`
	ExpectedIndexed map[string]any `json:"expected_indexed"`
	Source          struct {
		Generator *struct {
			NetworkPassphrase string `json:"network_passphrase"`
		} `json:"generator"`
	} `json:"source"`
	Files []file            `json:"files"`
	blobs map[string]string `json:"-"`
}

type result struct {
	Fixture string            `json:"fixture"`
	Checks  map[string]string `json:"checks"`
	Failed  []string          `json:"failed"`
	Detail  []string          `json:"detail"`
}

var passphrase = map[string]string{"pubnet": network.PublicNetworkPassphrase, "testnet": network.TestNetworkPassphrase, "local": "Standalone Network ; February 2017"}

func passphraseOf(m manifest) string {
	if g := m.Source.Generator; g != nil && g.NetworkPassphrase != "" {
		return g.NetworkPassphrase
	}
	return passphrase[m.Network]
}

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
	case "ScVal":
		return &xdr.ScVal{}, nil
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
	case []any:
		parts := make([]string, len(x))
		for i, p := range x {
			parts[i] = str(p)
		}
		return strings.Join(parts, ",")
	}
	return fmt.Sprint(v)
}

// A named check: the expected value and a function producing the observed one.
// Each is evaluated on its own, so one failing (or panicking) check doesn't hide the rest.
type row struct {
	name, want string
	got        func() (string, error)
}

func ok(s string) (string, error) { return s, nil }

func muxedParts(mx xdr.MuxedAccount) (id string, account string, err error) {
	n, err := mx.GetId()
	if err != nil {
		return "", "", err
	}
	acc := mx.ToAccountId()
	return strconv.FormatUint(n, 10), acc.Address(), nil
}

func nativeChecks(m manifest, dec map[string]any) ([]row, error) {
	e, ix := m.ExpectedDecoded, m.ExpectedIndexed
	env, _ := dec["envelope"].(*xdr.TransactionEnvelope)
	switch m.Pattern {
	case "muxed-payment":
		i, _ := strconv.Atoi(str(e["op_index"]))
		pay := func() xdr.PaymentOp { return env.Operations()[i].Body.MustPaymentOp() }
		return []row{
			{"destination_muxed", str(e["destination_muxed"]), func() (string, error) { d := pay().Destination; return d.GetAddress() }},
			{"muxed_id", str(e["muxed_id"]), func() (string, error) { id, _, err := muxedParts(pay().Destination); return id, err }},
			{"destination_account", str(e["destination_account"]), func() (string, error) { _, a, err := muxedParts(pay().Destination); return a, err }},
			{"asset", str(e["asset"]), func() (string, error) { return ok(pay().Asset.StringCanonical()) }},
			{"amount", str(e["amount"]), func() (string, error) { return ok(amount.String(pay().Amount)) }},
		}, nil
	case "fee-bump":
		pp := passphraseOf(m)
		return []row{
			{"tx_hash", str(e["tx_hash"]), func() (string, error) {
				h, err := network.HashTransactionInEnvelope(*env, pp)
				return hex.EncodeToString(h[:]), err
			}},
			{"inner_tx_hash", str(e["inner_tx_hash"]), func() (string, error) {
				inner := xdr.TransactionEnvelope{Type: xdr.EnvelopeTypeEnvelopeTypeTx, V1: env.FeeBump.Tx.InnerTx.V1}
				h, err := network.HashTransactionInEnvelope(inner, pp)
				return hex.EncodeToString(h[:]), err
			}},
			{"fee_source", str(e["fee_source"]), func() (string, error) { a := env.FeeBumpAccount().ToAccountId(); return ok(a.Address()) }},
			{"inner_source", str(e["inner_source"]), func() (string, error) { a := env.SourceAccount().ToAccountId(); return ok(a.Address()) }},
		}, nil
	case "signed-payload-signer":
		data := dec["ledger_entry"].(*xdr.LedgerEntryData)
		s := func() xdr.Signer { return data.MustAccount().Signers[0] }
		return []row{
			{"signer_strkey", str(e["signer_strkey"]), func() (string, error) { k := s().Key; return k.GetAddress() }},
			{"signer_ed25519", str(e["signer_ed25519"]), func() (string, error) {
				sp := s().Key.MustEd25519SignedPayload()
				return strkey.Encode(strkey.VersionByteAccountID, sp.Ed25519[:])
			}},
			{"payload_hex", str(e["payload_hex"]), func() (string, error) { return ok(hex.EncodeToString(s().Key.MustEd25519SignedPayload().Payload)) }},
			{"weight", str(e["weight"]), func() (string, error) { return ok(strconv.Itoa(int(s().Weight))) }},
		}, nil
	case "sac-trust":
		meta := dec["meta"].(*xdr.TransactionMeta)
		created := func() []xdr.TrustLineEntry {
			var out []xdr.TrustLineEntry
			if meta.V4 == nil {
				return out
			}
			for _, op := range meta.V4.Operations {
				for _, c := range op.Changes {
					if c.Type == xdr.LedgerEntryChangeTypeLedgerEntryCreated && c.Created.Data.Type == xdr.LedgerEntryTypeTrustline {
						out = append(out, *c.Created.Data.TrustLine)
					}
				}
			}
			return out
		}
		tl := func() (xdr.TrustLineEntry, error) {
			c := created()
			if len(c) == 0 {
				return xdr.TrustLineEntry{}, fmt.Errorf("no trustline created")
			}
			return c[0], nil
		}
		return []row{
			{"trustline_created", "true", func() (string, error) { return ok(strconv.FormatBool(len(created()) == 1)) }},
			{"account", str(ix["account"]), func() (string, error) { t, err := tl(); return t.AccountId.Address(), err }},
			{"asset", str(ix["asset"]), func() (string, error) { t, err := tl(); return t.Asset.ToAsset().StringCanonical(), err }},
			{"limit", str(ix["limit"]), func() (string, error) { t, err := tl(); return strconv.FormatInt(int64(t.Limit), 10), err }},
		}, nil
	case "muxed-max-id":
		dest := func() xdr.MuxedAccount { return env.Operations()[0].Body.MustPaymentOp().Destination }
		return []row{
			{"source_muxed", str(e["source_muxed"]), func() (string, error) { src := env.SourceAccount(); return src.GetAddress() }},
			{"source_muxed_id", str(e["source_muxed_id"]), func() (string, error) { id, _, err := muxedParts(env.SourceAccount()); return id, err }},
			{"source_account", str(e["source_account"]), func() (string, error) { _, a, err := muxedParts(env.SourceAccount()); return a, err }},
			{"destination_muxed_id", str(e["destination_muxed_id"]), func() (string, error) { id, _, err := muxedParts(dest()); return id, err }},
			{"destination_account", str(e["destination_account"]), func() (string, error) { _, a, err := muxedParts(dest()); return a, err }},
			{"amount", str(e["amount"]), func() (string, error) { return ok(amount.String(env.Operations()[0].Body.MustPaymentOp().Amount)) }},
			// Parsing the M-address string must give back the same 64-bit ID.
			{"muxed_address_roundtrip", str(e["destination_muxed_id"]), func() (string, error) {
				mx, err := xdr.AddressToMuxedAccount(str(e["destination_muxed"]))
				if err != nil {
					return "", err
				}
				id, _, err := muxedParts(mx)
				return id, err
			}},
		}, nil
	case "pool-issuer-order":
		params := func() xdr.LiquidityPoolConstantProductParameters {
			return env.Operations()[2].Body.MustChangeTrustOp().Line.MustLiquidityPool().MustConstantProduct()
		}
		return []row{
			{"decode_pool_share_op", str(e["asset_a"]) + "/" + str(e["asset_b"]), func() (string, error) {
				p := params()
				return ok(p.AssetA.StringCanonical() + "/" + p.AssetB.StringCanonical())
			}},
			{"asset_compare", "-1", func() (string, error) {
				p := params()
				if p.AssetA.LessThan(p.AssetB) {
					return ok("-1")
				}
				return ok("1")
			}},
			{"pool_id", str(e["pool_id"]), func() (string, error) {
				p := params()
				id, err := xdr.NewPoolId(p.AssetA, p.AssetB, p.Fee)
				return hex.EncodeToString(id[:]), err
			}},
		}, nil
	case "max-amount":
		pay := func() xdr.PaymentOp { return env.Operations()[0].Body.MustPaymentOp() }
		return []row{
			{"amount", str(e["amount"]), func() (string, error) { return ok(amount.String(pay().Amount)) }},
			{"amount_stroops", str(e["amount_stroops"]), func() (string, error) { return ok(strconv.FormatInt(int64(pay().Amount), 10)) }},
			{"asset", str(e["asset"]), func() (string, error) { return ok(pay().Asset.StringCanonical()) }},
		}, nil
	case "memo-non-utf8":
		return []row{
			{"memo_bytes", str(e["memo_hex"]), func() (string, error) { return ok(hex.EncodeToString([]byte(env.Memo().MustText()))) }},
		}, nil
	case "max-length-vectors":
		signed := dec["envelope_signatures"].(*xdr.TransactionEnvelope)
		acct := func() xdr.AccountEntry { return dec["ledger_entry"].(*xdr.LedgerEntryData).MustAccount() }
		return []row{
			{"operation_count", str(e["operation_count"]), func() (string, error) { return ok(strconv.Itoa(len(env.Operations()))) }},
			{"signature_count", str(e["signature_count"]), func() (string, error) { return ok(strconv.Itoa(len(signed.Signatures()))) }},
			{"signer_count", str(e["signer_count"]), func() (string, error) { return ok(strconv.Itoa(len(acct().Signers))) }},
			{"thresholds", str(e["thresholds"]), func() (string, error) {
				t := acct().Thresholds
				return ok(fmt.Sprintf("%d,%d,%d", t[1], t[2], t[3]))
			}},
		}, nil
	case "scmap-host-order":
		entries := func() xdr.ScMap { return **dec["ledger_entry"].(*xdr.LedgerEntryData).MustContractData().Val.Map }
		return []row{
			{"entry_count", str(e["entry_count"]), func() (string, error) { return ok(strconv.Itoa(len(entries()))) }},
			{"key_order_preserved", str(e["keys_xdr"]), func() (string, error) {
				keys := []string{}
				for _, en := range entries() {
					k, err := xdr.MarshalBase64(en.Key)
					if err != nil {
						return "", err
					}
					keys = append(keys, k)
				}
				return ok(strings.Join(keys, ","))
			}},
		}, nil
	case "nested-auth":
		meta := dec["meta"].(*xdr.TransactionMeta)
		walk := func() (depth, count int, root xdr.SorobanAuthorizedInvocation, err error) {
			root = env.Operations()[0].Body.MustInvokeHostFunctionOp().Auth[0].RootInvocation
			type item struct {
				inv xdr.SorobanAuthorizedInvocation
				d   int
			}
			stack := []item{{root, 1}}
			for len(stack) > 0 {
				it := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				if it.d > 100 { // the host's own depth limit
					return 0, 0, root, fmt.Errorf("auth tree deeper than 100")
				}
				depth, count = max(depth, it.d), count+1
				for _, s := range it.inv.SubInvocations {
					stack = append(stack, item{s, it.d + 1})
				}
			}
			return depth, count, root, nil
		}
		return []row{
			{"auth_depth", str(e["auth_depth"]), func() (string, error) { d, _, _, err := walk(); return strconv.Itoa(d), err }},
			{"auth_invocations", str(e["auth_invocations"]), func() (string, error) { _, c, _, err := walk(); return strconv.Itoa(c), err }},
			{"root_contract", str(e["root_contract"]), func() (string, error) {
				_, _, r, err := walk()
				if err != nil {
					return "", err
				}
				return r.Function.MustContractFn().ContractAddress.String()
			}},
			{"return_value", str(e["return_u32"]), func() (string, error) {
				return ok(strconv.FormatUint(uint64(meta.MustV4().SorobanMeta.ReturnValue.MustU32()), 10))
			}},
		}, nil
	case "muxed-soroban-source":
		return []row{
			{"source_account", str(e["source_account"]), func() (string, error) { _, a, err := muxedParts(env.SourceAccount()); return a, err }},
			{"source_muxed_id", str(e["source_muxed_id"]), func() (string, error) { id, _, err := muxedParts(env.SourceAccount()); return id, err }},
			{"operation", str(e["operation"]), func() (string, error) {
				if env.Operations()[0].Body.Type == xdr.OperationTypeExtendFootprintTtl {
					return ok("extendFootprintTtl")
				}
				return ok(env.Operations()[0].Body.Type.String())
			}},
		}, nil
	}
	return nil, fmt.Errorf("no native check for pattern %q", m.Pattern)
}

func evaluate(x row) (got string, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("panic: %v", p)
		}
	}()
	return x.got()
}

func run(m manifest) result {
	r := result{Fixture: m.ID, Checks: map[string]string{"decode": "fail", "reencode": "fail", "native": "fail"}, Failed: []string{}, Detail: []string{}}
	// Bytes a decoder must refuse: pass when every one fails to decode.
	negative := 0
	for _, f := range m.Files {
		if f.Expect == "decode_error" {
			negative++
		}
	}
	if negative > 0 && negative == len(m.Files) {
		r.Checks = map[string]string{"decode": "pass", "reencode": "n/a", "native": "n/a"}
		for _, f := range m.Files {
			v, err := newValue(f.XdrType)
			if err == nil {
				err = xdr.SafeUnmarshalBase64(m.blobs[f.Name], v)
			}
			if err == nil {
				r.Checks["decode"] = "fail"
				r.Failed = append(r.Failed, "rejects:"+f.Name)
				r.Detail = append(r.Detail, f.Name+": decoded, but must be rejected")
			}
		}
		return r
	}
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
		// A check whose expected value this fixture doesn't carry doesn't apply.
		if x.want == "<nil>" {
			continue
		}
		got, err := evaluate(x)
		if err != nil {
			got = "error: " + err.Error()
		}
		if x.want != got {
			r.Checks["native"] = "fail"
			r.Failed = append(r.Failed, x.name)
			r.Detail = append(r.Detail, fmt.Sprintf("%s: expected %s, got %s", x.name, x.want, got))
		}
	}
	return r
}

func main() {
	corpus := "../../corpus"
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
