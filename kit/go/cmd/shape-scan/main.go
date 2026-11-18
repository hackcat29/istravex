// Command shape-scan reads ledgers and records which XDR cells (union arms,
// and the flag bits a reader has to interpret) each transaction and each
// ledger exercises.
//
// Ledgers stream from SDF's public data lake (pubnet, or testnet since its
// last reset). Nothing is written to disk. Output is JSON lines:
//
//	{"kind":"tx","network":"pubnet","ledger":N,"tx_hash":"…","successful":true,"cells":[…]}
//	{"kind":"ledger","network":"pubnet","ledger":N,"protocol":29,"cells":[…]}
//	{"kind":"summary",…,"cell_counts":{…},"universe":[…]}
//
// A transaction or ledger is printed only while it still adds a cell seen
// fewer than -keep times, so the output stays small; the summary counts every
// occurrence. kit/capture/shapes.mjs picks fixtures from it by set cover.
//
//	go run ./cmd/shape-scan -from 65400000 -to 65410000 -step 50 > shapes.jsonl
//	go run ./cmd/shape-scan -network testnet -ledgers 5787000,5787001
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"
	"github.com/stellar/go-stellar-sdk/ingest"
	"github.com/stellar/go-stellar-sdk/network"
	"github.com/stellar/go-stellar-sdk/xdr"
)

// SDF's public data lake. Testnet's prefix changes when testnet is reset.
var lakes = map[string]string{
	"pubnet":  "https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet",
	"testnet": "https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/testnet/2025-12-18",
}

var client = &http.Client{Timeout: 90 * time.Second}

func objectURL(netName string, seq uint32) string {
	start := seq / 64000 * 64000
	rev := func(n uint32) string { return fmt.Sprintf("%08X", math.MaxUint32-n) }
	return fmt.Sprintf("%s/%s--%d-%d/%s--%d.xdr.zst", lakes[netName], rev(start), start, start+63999, rev(seq), seq)
}

func retry(f func() error) error {
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		if err = f(); err == nil {
			return nil
		}
		time.Sleep(time.Duration(attempt+1) * time.Second)
	}
	return err
}

func fetchLake(ctx context.Context, netName string, dec *zstd.Decoder, seq uint32) (xdr.LedgerCloseMeta, error) {
	var lcm xdr.LedgerCloseMeta
	var body []byte
	err := retry(func() error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, objectURL(netName, seq), nil)
		if err != nil {
			return err
		}
		res, err := client.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return fmt.Errorf("HTTP %d", res.StatusCode)
		}
		body, err = io.ReadAll(res.Body)
		return err
	})
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

type record struct {
	Kind       string   `json:"kind"`
	Network    string   `json:"network"`
	Ledger     uint32   `json:"ledger"`
	Protocol   uint32   `json:"protocol,omitempty"`
	TxHash     string   `json:"tx_hash,omitempty"`
	Successful *bool    `json:"successful,omitempty"`
	Operations []string `json:"operations,omitempty"`
	Cells      []string `json:"cells"`
}

var ledgerSkip = map[reflect.Type]bool{
	reflect.TypeOf(xdr.TransactionEnvelope{}):     true,
	reflect.TypeOf(xdr.TransactionResultMeta{}):   true,
	reflect.TypeOf(xdr.TransactionResultMetaV1{}): true,
}

func cellsOf(f func(record func(string))) []string {
	set := map[string]bool{}
	f(func(c string) { set[c] = true })
	out := make([]string, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

func scan(netName, passphrase string, lcm xdr.LedgerCloseMeta, emit func(record)) error {
	seq := lcm.LedgerSequence()
	proto := uint32(lcm.ProtocolVersion())
	emit(record{Kind: "ledger", Network: netName, Ledger: seq, Protocol: proto,
		Cells: cellsOf(func(r func(string)) { walk(reflect.ValueOf(lcm), ledgerSkip, r) })})
	rd, err := ingest.NewLedgerTransactionReaderFromLedgerCloseMeta(passphrase, lcm)
	if err != nil {
		return err
	}
	defer rd.Close()
	for {
		tx, err := rd.Read()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		ok := tx.Result.Successful()
		ops := make([]string, 0, len(tx.Envelope.Operations()))
		for _, op := range tx.Envelope.Operations() {
			ops = append(ops, screaming("OperationType", op.Body.Type.String()))
		}
		cells := cellsOf(func(r func(string)) {
			walk(reflect.ValueOf(tx.Envelope), nil, r)
			walk(reflect.ValueOf(tx.Result), nil, r)
			walk(reflect.ValueOf(tx.UnsafeMeta), nil, r)
			walk(reflect.ValueOf(tx.FeeChanges), nil, r)
			walk(reflect.ValueOf(tx.PostTxApplyFeeChanges), nil, r)
		})
		emit(record{Kind: "tx", Network: netName, Ledger: seq, Protocol: proto, TxHash: tx.Hash.HexString(),
			Successful: &ok, Operations: ops, Cells: cells})
	}
}

func parseLedgers(s string) []uint32 {
	var out []uint32
	for _, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		n, err := strconv.ParseUint(p, 10, 32)
		if err != nil {
			fmt.Fprintln(os.Stderr, "bad ledger:", p)
			os.Exit(2)
		}
		out = append(out, uint32(n))
	}
	return out
}

func main() {
	netName := flag.String("network", "pubnet", "pubnet or testnet")
	from := flag.Uint("from", 0, "first ledger")
	to := flag.Uint("to", 0, "last ledger (inclusive)")
	step := flag.Uint("step", 1, "scan every Nth ledger in [from, to]")
	list := flag.String("ledgers", "", "comma-separated ledgers (instead of -from/-to)")
	keep := flag.Int("keep", 3, "print a tx or ledger while it adds a cell seen fewer than this many times")
	workers := flag.Int("workers", 48, "concurrent downloads")
	printUniverse := flag.Bool("universe", false, "print every cell a reader can meet and exit")
	corpusDir := flag.String("corpus", "", "print the cells each fixture in this corpus exercises and exit")
	casesFile := flag.String("cases", "", "print the cells the valid generated cases in this file exercise and exit")
	flag.Parse()

	if *casesFile != "" {
		counts, n, err := casesCells(*casesFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		all, reachable := universe()
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"valid_cases": n, "cells": counts, "universe": len(all), "reachable": len(reachable)})
		return
	}

	if *corpusDir != "" {
		fc, err := corpusCells(*corpusDir)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(fc)
		return
	}

	if *printUniverse {
		all, reachable := universe()
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"all": all, "reachable": reachable})
		return
	}
	seqs := parseLedgers(*list)
	if len(seqs) == 0 {
		if *from == 0 || *to < *from || *step == 0 {
			fmt.Fprintln(os.Stderr, "usage: shape-scan -from N -to M [-step K] | -ledgers a,b,c")
			os.Exit(2)
		}
		for s := *from; s <= *to; s += *step {
			seqs = append(seqs, uint32(s))
		}
	}
	passphrase := network.PublicNetworkPassphrase
	if *netName == "testnet" {
		passphrase = network.TestNetworkPassphrase
	} else if *netName != "pubnet" {
		fmt.Fprintln(os.Stderr, "-network must be pubnet or testnet")
		os.Exit(2)
	}

	ctx := context.Background()
	var mu sync.Mutex
	out := json.NewEncoder(os.Stdout)
	counts := map[string]int{}
	var txs, ledgersDone, failed int
	emit := func(r record) {
		mu.Lock()
		defer mu.Unlock()
		if r.Kind == "tx" {
			txs++
		}
		useful := false
		for _, c := range r.Cells {
			if counts[c] < *keep {
				useful = true
			}
			counts[c]++
		}
		if useful {
			_ = out.Encode(r)
		}
	}
	work := make(chan uint32)
	var wg sync.WaitGroup
	for w := 0; w < *workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			dec, _ := zstd.NewReader(nil)
			defer dec.Close()
			for seq := range work {
				lcm, err := fetchLake(ctx, *netName, dec, seq)
				if err == nil {
					err = scan(*netName, passphrase, lcm, emit)
				}
				mu.Lock()
				ledgersDone++
				if err != nil {
					failed++
					fmt.Fprintln(os.Stderr, "error:", err)
				}
				if ledgersDone%200 == 0 {
					fmt.Fprintf(os.Stderr, "%d/%d ledgers, %d cells\n", ledgersDone, len(seqs), len(counts))
				}
				mu.Unlock()
			}
		}()
	}
	for _, s := range seqs {
		work <- s
	}
	close(work)
	wg.Wait()
	_, reachable := universe()
	_ = out.Encode(map[string]any{"kind": "summary", "network": *netName, "ledgers": ledgersDone, "failed": failed,
		"transactions": txs, "cell_counts": counts, "universe_size": len(reachable)})
	fmt.Fprintf(os.Stderr, "scanned %d ledgers (%d failed), %d transactions, %d of %d reachable cells seen\n", ledgersDone, failed, txs, len(counts), len(reachable))
	if failed > ledgersDone/50 {
		os.Exit(1)
	}
}
