// Command mainnet-scan searches mainnet history for the corpus's patterns.
//
// It streams ledgers straight from SDF's public data lake (Galexie output on
// AWS Open Data: no keys, no Horizon, nothing written to disk), reads every
// successful transaction, and prints one JSON line per candidate:
//
//	{"pattern":"memo-non-utf8","ledger":65474279,"tx_hash":"…","detail":{…}}
//
// .github/workflows/mainnet-scan.yml runs it in shards on GitHub's runners,
// which are close to the data; kit/capture/mainnet.mjs turns chosen
// candidates into fixtures, pinned by transaction hash.
//
//	go run ./cmd/mainnet-scan -from 65400000 -to 65410000 > candidates.jsonl
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/klauspost/compress/zstd"
	"github.com/stellar/go-stellar-sdk/ingest"
	"github.com/stellar/go-stellar-sdk/network"
	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/xdr"
)

const lake = "https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet"

func objectURL(seq uint32) string {
	start := seq / 64000 * 64000
	rev := func(n uint32) string { return fmt.Sprintf("%08X", math.MaxUint32-n) }
	return fmt.Sprintf("%s/%s--%d-%d/%s--%d.xdr.zst", lake, rev(start), start, start+63999, rev(seq), seq)
}

type candidate struct {
	Pattern string         `json:"pattern"`
	Ledger  uint32         `json:"ledger"`
	TxHash  string         `json:"tx_hash"`
	Detail  map[string]any `json:"detail"`
}

var client = &http.Client{Timeout: 60 * time.Second}

func fetch(ctx context.Context, dec *zstd.Decoder, seq uint32) (xdr.LedgerCloseMeta, error) {
	var lcm xdr.LedgerCloseMeta
	var body []byte
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		var req *http.Request
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, objectURL(seq), nil)
		if err != nil {
			return lcm, err
		}
		var res *http.Response
		res, err = client.Do(req)
		if err == nil {
			body, err = io.ReadAll(res.Body)
			res.Body.Close()
			if err == nil && res.StatusCode != http.StatusOK {
				err = fmt.Errorf("HTTP %d", res.StatusCode)
			}
		}
		if err == nil {
			break
		}
		time.Sleep(time.Duration(attempt+1) * time.Second)
	}
	if err != nil {
		return lcm, fmt.Errorf("ledger %d: %w", seq, err)
	}
	raw, err := dec.DecodeAll(body, nil)
	if err != nil {
		return lcm, err
	}
	var batch xdr.LedgerCloseMetaBatch
	if err := batch.UnmarshalBinary(raw); err != nil {
		return lcm, err
	}
	for _, m := range batch.LedgerCloseMetas {
		if m.LedgerSequence() == seq {
			return m, nil
		}
	}
	return lcm, fmt.Errorf("ledger %d not in its batch", seq)
}

func muxedID(m xdr.MuxedAccount) (uint64, bool) {
	if m.Type != xdr.CryptoKeyTypeKeyTypeMuxedEd25519 {
		return 0, false
	}
	return uint64(m.Med25519.Id), true
}

// authDepth is the depth of an authorization tree, walked with a stack and
// the host's own limit.
func authDepth(root xdr.SorobanAuthorizedInvocation) (depth, nodes int) {
	type item struct {
		inv xdr.SorobanAuthorizedInvocation
		d   int
	}
	stack := []item{{root, 1}}
	for len(stack) > 0 && nodes < 100000 {
		it := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		nodes++
		if it.d > depth {
			depth = it.d
		}
		if it.d >= 100 {
			continue
		}
		for _, s := range it.inv.SubInvocations {
			stack = append(stack, item{s, it.d + 1})
		}
	}
	return depth, nodes
}

// nativeName is how a JavaScript-style conversion prints an ScVal map key.
func nativeName(v xdr.ScVal) (string, bool) {
	switch v.Type {
	case xdr.ScValTypeScvSymbol:
		return string(*v.Sym), true
	case xdr.ScValTypeScvString:
		return string(*v.Str), true
	case xdr.ScValTypeScvU32:
		return strconv.FormatUint(uint64(*v.U32), 10), true
	case xdr.ScValTypeScvI32:
		return strconv.FormatInt(int64(*v.I32), 10), true
	case xdr.ScValTypeScvU64:
		return strconv.FormatUint(uint64(*v.U64), 10), true
	case xdr.ScValTypeScvI64:
		return strconv.FormatInt(int64(*v.I64), 10), true
	}
	return "", false
}

// inspectMaps walks an ScVal (bounded) and reports maps whose keys mix types
// or collide by native name.
func inspectMaps(v xdr.ScVal, depth int, report func(kind string, keyTypes []string, entries int)) {
	if depth > 64 {
		return
	}
	switch v.Type {
	case xdr.ScValTypeScvVec:
		if v.Vec != nil && *v.Vec != nil {
			for _, c := range **v.Vec {
				inspectMaps(c, depth+1, report)
			}
		}
	case xdr.ScValTypeScvMap:
		if v.Map == nil || *v.Map == nil {
			return
		}
		m := **v.Map
		types := map[string]bool{}
		names := map[string]int{}
		collide := false
		for _, e := range m {
			types[e.Key.Type.String()] = true
			if n, ok := nativeName(e.Key); ok {
				names[n]++
				if names[n] > 1 {
					collide = true
				}
			}
			inspectMaps(e.Key, depth+1, report)
			inspectMaps(e.Val, depth+1, report)
		}
		keyTypes := make([]string, 0, len(types))
		for t := range types {
			keyTypes = append(keyTypes, t)
		}
		sort.Strings(keyTypes)
		if collide {
			report("colliding-keys", keyTypes, len(m))
		} else if len(types) >= 3 {
			report("mixed-key-types", keyTypes, len(m))
		}
	}
}

func scan(lcm xdr.LedgerCloseMeta, emit func(candidate)) error {
	r, err := ingest.NewLedgerTransactionReaderFromLedgerCloseMeta(network.PublicNetworkPassphrase, lcm)
	if err != nil {
		return err
	}
	defer r.Close()
	seq := lcm.LedgerSequence()
	for {
		tx, err := r.Read()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if !tx.Result.Successful() {
			continue
		}
		hash := tx.Hash.HexString()
		add := func(pattern string, d map[string]any) {
			emit(candidate{Pattern: pattern, Ledger: seq, TxHash: hash, Detail: d})
		}
		env := tx.Envelope
		ops := env.Operations()
		sigs := env.Signatures()

		if memo := env.Memo(); memo.Type == xdr.MemoTypeMemoText && !utf8.ValidString(memo.MustText()) {
			add("memo-non-utf8", map[string]any{"memo_hex": fmt.Sprintf("%x", memo.MustText()), "bytes": len(memo.MustText())})
		}
		if len(ops) == 100 || len(sigs) == 20 {
			add("max-length-vectors", map[string]any{"operations": len(ops), "signatures": len(sigs)})
		}
		src := env.SourceAccount()
		srcID, srcMuxed := muxedID(src)
		if srcMuxed && srcID > 1<<53 {
			add("muxed-max-id", map[string]any{"role": "source", "muxed_id": strconv.FormatUint(srcID, 10)})
		}
		soroban := tx.IsSorobanTx()
		for i, op := range ops {
			var opSrcMuxed bool
			if op.SourceAccount != nil {
				_, opSrcMuxed = muxedID(*op.SourceAccount)
			}
			if soroban && (srcMuxed || opSrcMuxed) {
				add("muxed-soroban-source", map[string]any{"op_index": i, "operation": op.Body.Type.String(), "tx_source_muxed": srcMuxed, "op_source_muxed": opSrcMuxed})
			}
			switch op.Body.Type {
			case xdr.OperationTypePayment:
				if id, ok := muxedID(op.Body.MustPaymentOp().Destination); ok && id > 1<<53 {
					add("muxed-max-id", map[string]any{"role": "destination", "op_index": i, "muxed_id": strconv.FormatUint(id, 10), "source_muxed": srcMuxed})
				}
			case xdr.OperationTypeSetOptions:
				if s := op.Body.MustSetOptionsOp().Signer; s != nil && s.Key.Type == xdr.SignerKeyTypeSignerKeyTypeEd25519SignedPayload {
					p, _ := s.Key.GetAddress()
					add("signed-payload-signer", map[string]any{"op_index": i, "signer": p, "weight": int(s.Weight)})
				}
			case xdr.OperationTypeChangeTrust:
				line := op.Body.MustChangeTrustOp().Line
				if line.Type == xdr.AssetTypeAssetTypePoolShare {
					cp := line.MustLiquidityPool().MustConstantProduct()
					a, b := cp.AssetA, cp.AssetB
					if a.Type != xdr.AssetTypeAssetTypeNative && b.Type != xdr.AssetTypeAssetTypeNative {
						var ca, ia, cb, ib string
						_ = a.Extract(nil, &ca, &ia)
						_ = b.Extract(nil, &cb, &ib)
						if ca == cb {
							byText := ia < ib
							ka, _ := strkey.Decode(strkey.VersionByteAccountID, ia)
							kb, _ := strkey.Decode(strkey.VersionByteAccountID, ib)
							byBytes := bytes.Compare(ka, kb) < 0
							if byText != byBytes {
								add("pool-issuer-order", map[string]any{"op_index": i, "asset_a": a.StringCanonical(), "asset_b": b.StringCanonical(), "code": cb})
							}
						}
					}
				}
			case xdr.OperationTypeInvokeHostFunction:
				ih := op.Body.MustInvokeHostFunctionOp()
				for _, a := range ih.Auth {
					if d, n := authDepth(a.RootInvocation); d >= 3 {
						add("nested-auth", map[string]any{"op_index": i, "auth_depth": d, "auth_invocations": n})
					}
				}
				if ih.HostFunction.Type == xdr.HostFunctionTypeHostFunctionTypeInvokeContract {
					ic := ih.HostFunction.MustInvokeContract()
					if string(ic.FunctionName) == "trust" {
						add("sac-trust", map[string]any{"op_index": i, "contract": func() string { s, _ := ic.ContractAddress.String(); return s }()})
					}
					for _, arg := range ic.Args {
						inspectMaps(arg, 0, func(kind string, keyTypes []string, entries int) {
							add("scmap-host-order", map[string]any{"op_index": i, "kind": kind, "key_types": keyTypes, "entries": entries})
						})
					}
				}
			}
		}
	}
}

func main() {
	from := flag.Uint("from", 0, "first ledger")
	to := flag.Uint("to", 0, "last ledger (inclusive)")
	workers := flag.Int("workers", 64, "concurrent downloads")
	flag.Parse()
	if *from == 0 || *to < *from {
		fmt.Fprintln(os.Stderr, "usage: mainnet-scan -from N -to M")
		os.Exit(2)
	}
	ctx := context.Background()
	seqs := make(chan uint32)
	var mu sync.Mutex
	out := json.NewEncoder(os.Stdout)
	emit := func(c candidate) {
		mu.Lock()
		defer mu.Unlock()
		_ = out.Encode(c)
	}
	var failed, done int
	var wg sync.WaitGroup
	for w := 0; w < *workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			dec, _ := zstd.NewReader(nil)
			defer dec.Close()
			for seq := range seqs {
				lcm, err := fetch(ctx, dec, seq)
				if err == nil {
					err = scan(lcm, emit)
				}
				mu.Lock()
				done++
				if err != nil {
					failed++
					fmt.Fprintln(os.Stderr, "error:", err)
				}
				if done%1000 == 0 {
					fmt.Fprintf(os.Stderr, "%d/%d ledgers\n", done, *to-*from+1)
				}
				mu.Unlock()
			}
		}()
	}
	for s := *from; s <= *to; s++ {
		seqs <- uint32(s)
	}
	close(seqs)
	wg.Wait()
	fmt.Fprintf(os.Stderr, "scanned %d ledgers, %d failed\n", done, failed)
	if failed > done/100 {
		os.Exit(1)
	}
}
