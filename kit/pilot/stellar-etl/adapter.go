//go:build istravex_pilot

// Reference adapter for stellar/stellar-etl. kit/pilot/stellar-etl.mjs copies
// this file into a pinned stellar-etl checkout (it imports the module's
// internal packages) and runs it over the corpus's canonical ledgers.
//
// stellar-etl's exports read Galexie files from a GCS datastore; the pilot
// reads the same LedgerCloseMetaBatch files from corpus/ledgers instead, and
// runs the transforms each export runs per transaction: TransformTransaction
// (export_transactions), TransformOperation (export_operations),
// TransformEffect (export_effects), and TransformSigners / TransformTrustline
// on the transaction's changes (export_ledger_entry_changes). It prints their
// output rows as stellar-etl would write them, unaltered.
//
//	go run -tags istravex_pilot ./istravex_pilot < requests.json
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/klauspost/compress/zstd"
	"github.com/stellar/go-stellar-sdk/ingest"
	"github.com/stellar/go-stellar-sdk/xdr"

	"github.com/stellar/stellar-etl/v2/internal/transform"
)

type request struct {
	Fixture    string `json:"fixture"`
	LedgerFile string `json:"ledger_file"`
	Passphrase string `json:"passphrase"`
	Ledger     uint32 `json:"ledger"`
	TxHash     string `json:"tx_hash"`
}

type output struct {
	Fixture     string   `json:"fixture"`
	Found       bool     `json:"found"`
	Error       string   `json:"error,omitempty"`
	Transaction any      `json:"transaction,omitempty"`
	Operations  []any    `json:"operations"`
	Effects     []any    `json:"effects"`
	Signers     []any    `json:"signers"`
	Trustlines  []any    `json:"trustlines"`
	Errors      []string `json:"transform_errors"`
}

func ledger(path string, seq uint32) (xdr.LedgerCloseMeta, error) {
	var lcm xdr.LedgerCloseMeta
	f, err := os.Open(path)
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
	var batch xdr.LedgerCloseMetaBatch
	if err := batch.UnmarshalBinary(raw); err != nil {
		return lcm, err
	}
	for _, m := range batch.LedgerCloseMetas {
		if m.LedgerSequence() == seq {
			return m, nil
		}
	}
	return lcm, fmt.Errorf("ledger %d not in %s", seq, path)
}

func run(req request) output {
	out := output{Fixture: req.Fixture, Operations: []any{}, Effects: []any{}, Signers: []any{}, Trustlines: []any{}, Errors: []string{}}
	lcm, err := ledger(req.LedgerFile, req.Ledger)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	reader, err := ingest.NewLedgerTransactionReaderFromLedgerCloseMeta(req.Passphrase, lcm)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	defer reader.Close()
	var tx ingest.LedgerTransaction
	for {
		t, err := reader.Read()
		if errors.Is(err, io.EOF) {
			return out
		}
		if err != nil {
			out.Error = err.Error()
			return out
		}
		if t.Hash.HexString() == req.TxHash {
			tx, out.Found = t, true
			break
		}
	}
	lhe := lcm.LedgerHeaderHistoryEntry()
	fail := func(what string, err error) { out.Errors = append(out.Errors, what+": "+err.Error()) }

	if row, err := transform.TransformTransaction(tx, lhe); err != nil {
		fail("TransformTransaction", err)
	} else {
		out.Transaction = row
	}
	for i, op := range tx.Envelope.Operations() {
		row, err := transform.TransformOperation(op, int32(i), tx, int32(req.Ledger), lcm, req.Passphrase)
		if err != nil {
			fail(fmt.Sprintf("TransformOperation[%d]", i), err)
			continue
		}
		out.Operations = append(out.Operations, row)
	}
	if rows, err := transform.TransformEffect(tx, req.Ledger, lcm, req.Passphrase); err != nil {
		fail("TransformEffect", err)
	} else {
		for _, r := range rows {
			out.Effects = append(out.Effects, r)
		}
	}
	changes, err := tx.GetChanges()
	if err != nil {
		fail("GetChanges", err)
	}
	for _, c := range changes {
		switch c.Type {
		case xdr.LedgerEntryTypeAccount:
			rows, err := transform.TransformSigners(c, lhe)
			if err != nil {
				fail("TransformSigners", err)
				continue
			}
			for _, r := range rows {
				out.Signers = append(out.Signers, r)
			}
		case xdr.LedgerEntryTypeTrustline:
			row, err := transform.TransformTrustline(c, lhe)
			if err != nil {
				fail("TransformTrustline", err)
				continue
			}
			out.Trustlines = append(out.Trustlines, row)
		}
	}
	return out
}

func main() {
	var reqs []request
	if err := json.NewDecoder(os.Stdin).Decode(&reqs); err != nil {
		fmt.Fprintln(os.Stderr, "decode requests:", err)
		os.Exit(2)
	}
	outs := make([]output, 0, len(reqs))
	for _, r := range reqs {
		outs = append(outs, run(r))
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(outs); err != nil {
		os.Exit(1)
	}
}
