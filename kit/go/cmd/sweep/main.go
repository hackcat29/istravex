// Command sweep checks go-stellar-sdk against whole ledgers of real traffic.
//
// For every LedgerCloseMetaBatch file given (raw XDR, as the data lake's
// objects decompress to):
//
//   - the batch decodes and re-encodes byte for byte;
//   - the hash the SDK computes for every transaction in the transaction set
//     equals the hash stellar-core recorded for it in the ledger's results.
//
// Both oracles are stellar-core's own bytes, not another SDK.
//
//	go run ./cmd/sweep -passphrase "…" ledger1.xdr ledger2.xdr … > sweep-go.json
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"

	"github.com/stellar/go-stellar-sdk/network"
	"github.com/stellar/go-stellar-sdk/xdr"
)

type failure struct {
	Ledger string `json:"ledger"`
	Check  string `json:"check"`
	Detail string `json:"detail"`
}

func envelopes(lcm xdr.LedgerCloseMeta) []xdr.TransactionEnvelope {
	switch lcm.V {
	case 0:
		return lcm.MustV0().TxSet.Txs
	}
	var set xdr.GeneralizedTransactionSet
	if lcm.V == 1 {
		set = lcm.MustV1().TxSet
	} else {
		set = lcm.MustV2().TxSet
	}
	var out []xdr.TransactionEnvelope
	for _, phase := range set.MustV1TxSet().Phases {
		switch phase.V {
		case 0:
			for _, c := range *phase.V0Components {
				out = append(out, c.MustTxsMaybeDiscountedFee().Txs...)
			}
		case 1:
			for _, stage := range phase.MustParallelTxsComponent().ExecutionStages {
				for _, cluster := range stage {
					out = append(out, cluster...)
				}
			}
		}
	}
	return out
}

func resultHashes(lcm xdr.LedgerCloseMeta) []string {
	var out []string
	switch lcm.V {
	case 0:
		for _, t := range lcm.MustV0().TxProcessing {
			out = append(out, hex.EncodeToString(t.Result.TransactionHash[:]))
		}
	case 1:
		for _, t := range lcm.MustV1().TxProcessing {
			out = append(out, hex.EncodeToString(t.Result.TransactionHash[:]))
		}
	default:
		for _, t := range lcm.MustV2().TxProcessing {
			out = append(out, hex.EncodeToString(t.Result.TransactionHash[:]))
		}
	}
	sort.Strings(out)
	return out
}

func main() {
	pp := flag.String("passphrase", network.PublicNetworkPassphrase, "network passphrase")
	flag.Parse()
	fails := []failure{}
	ledgers, txs, checks, passed := 0, 0, 0, 0
	check := func(ledger, name string, ok bool, detail string) {
		checks++
		if ok {
			passed++
		} else {
			fails = append(fails, failure{ledger, name, detail})
		}
	}
	for _, path := range flag.Args() {
		name := filepath.Base(path)
		raw, err := os.ReadFile(path)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		var batch xdr.LedgerCloseMetaBatch
		if err := batch.UnmarshalBinary(raw); err != nil {
			check(name, "decode", false, err.Error())
			continue
		}
		again, err := batch.MarshalBinary()
		check(name, "reencode", err == nil && bytes.Equal(again, raw), fmt.Sprintf("%d vs %d bytes", len(again), len(raw)))
		for _, lcm := range batch.LedgerCloseMetas {
			ledgers++
			want := resultHashes(lcm)
			var got []string
			for _, env := range envelopes(lcm) {
				h, err := network.HashTransactionInEnvelope(env, *pp)
				if err != nil {
					got = append(got, "error: "+err.Error())
					continue
				}
				got = append(got, hex.EncodeToString(h[:]))
			}
			sort.Strings(got)
			txs += len(want)
			inSet := map[string]bool{}
			for _, h := range got {
				inSet[h] = true
			}
			for _, h := range want {
				check(fmt.Sprint(lcm.LedgerSequence()), "tx_hash", inSet[h], h)
			}
			check(fmt.Sprint(lcm.LedgerSequence()), "tx_count", len(got) == len(want), fmt.Sprintf("%d envelopes, %d results", len(got), len(want)))
		}
	}
	version := "unknown"
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			if d.Path == "github.com/stellar/go-stellar-sdk" {
				version = d.Version
			}
		}
	}
	if len(fails) > 50 {
		fails = fails[:50]
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
		"sdk": "go", "package": "github.com/stellar/go-stellar-sdk", "version": version,
		"ledgers": ledgers, "transactions": txs, "checks": checks, "passed": passed, "failures": fails,
	})
}
