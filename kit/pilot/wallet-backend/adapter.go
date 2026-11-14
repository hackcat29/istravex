//go:build istravex_pilot

// Reference adapter for stellar/wallet-backend. kit/pilot/wallet-backend.mjs
// copies this file into a pinned wallet-backend checkout (it imports the
// module's internal packages) and runs it against the mock RPC.
//
// For each request it uses wallet-backend's own ledger backend factory
// (ingest.NewLedgerBackend, type "rpc") to fetch the ledger through
// getLedgers, then runs indexer.ProcessLedger, the same per-ledger function
// live ingestion calls, and prints what the indexer produced for the fixture's
// transaction as JSON. Nothing is written to a database; the output is exactly
// what ingestion would hand to persistence.
//
//	go run -tags istravex_pilot ./istravex_pilot < requests.json
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"

	"github.com/alitto/pond/v2"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/stellar/go-stellar-sdk/ingest/ledgerbackend"

	"github.com/stellar/wallet-backend/internal/indexer"
	"github.com/stellar/wallet-backend/internal/ingest"
	"github.com/stellar/wallet-backend/internal/metrics"
)

type request struct {
	Fixture    string `json:"fixture"`
	RPCURL     string `json:"rpc_url"`
	Passphrase string `json:"passphrase"`
	Ledger     uint32 `json:"ledger"`
	TxHash     string `json:"tx_hash"`
}

// All 64-bit integers are emitted as JSON strings: consumers in JavaScript
// would otherwise round anything above 2^53 (operation IDs, i64 limits).

type transaction struct {
	Hash       string `json:"hash"`
	InnerHash  string `json:"inner_hash"`
	ToID       int64  `json:"to_id,string"`
	FeeCharged int64  `json:"fee_charged,string"`
	IsFeeBump  bool   `json:"is_fee_bump"`
	ResultCode string `json:"result_code"`
	Ledger     uint32 `json:"ledger"`
}

type trustline struct {
	Account     string `json:"account"`
	Asset       string `json:"asset"`
	OperationID int64  `json:"operation_id,string"`
	Operation   string `json:"operation"`
	Balance     int64  `json:"balance,string"`
	Limit       int64  `json:"limit,string"`
	Flags       uint32 `json:"flags"`
}

type account struct {
	Account   string `json:"account"`
	Operation string `json:"operation"`
	Balance   int64  `json:"balance,string"`
}

type stateChange struct {
	Category    string `json:"category"`
	Reason      string `json:"reason,omitempty"`
	Account     string `json:"account"`
	OperationID int64  `json:"operation_id,string"`
	Token       string `json:"token,omitempty"`
	Amount      string `json:"amount,omitempty"`
	ToMuxedID   string `json:"to_muxed_id,omitempty"`
	Signer      string `json:"signer,omitempty"`
	SignerOld   *int16 `json:"signer_weight_old,omitempty"`
	SignerNew   *int16 `json:"signer_weight_new,omitempty"`
	LimitNew    string `json:"trustline_limit_new,omitempty"`
}

type output struct {
	Fixture      string        `json:"fixture"`
	Found        bool          `json:"found"`
	Error        string        `json:"error,omitempty"`
	Transaction  *transaction  `json:"transaction,omitempty"`
	Participants []string      `json:"participants"`
	StateChanges []stateChange `json:"state_changes"`
	Trustlines   []trustline   `json:"trustline_changes"`
	Accounts     []account     `json:"account_changes"`
}

func run(ctx context.Context, req request) output {
	out := output{Fixture: req.Fixture, Participants: []string{}, StateChanges: []stateChange{}, Trustlines: []trustline{}, Accounts: []account{}}
	backend, err := ingest.NewLedgerBackend(ctx, ingest.Configs{
		LedgerBackendType: ingest.LedgerBackendTypeRPC,
		RPCURL:            req.RPCURL,
		GetLedgersLimit:   1,
		NetworkPassphrase: req.Passphrase,
	})
	if err != nil {
		out.Error = err.Error()
		return out
	}
	defer backend.Close()
	if err := backend.PrepareRange(ctx, ledgerbackend.BoundedRange(req.Ledger, req.Ledger)); err != nil {
		out.Error = "prepare: " + err.Error()
		return out
	}
	lcm, err := backend.GetLedger(ctx, req.Ledger)
	if err != nil {
		out.Error = "get ledger: " + err.Error()
		return out
	}

	pool := pond.NewPool(4)
	defer pool.StopAndWait()
	m := metrics.NewMetrics(prometheus.NewRegistry())
	idx, err := indexer.NewIndexer(req.Passphrase, pool, m.Ingestion, false)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	buf := indexer.NewIndexerBuffer()
	if _, err := indexer.ProcessLedger(ctx, req.Passphrase, lcm, idx, buf); err != nil {
		out.Error = "process: " + err.Error()
		return out
	}

	var toID int64
	for _, tx := range buf.GetTransactions() {
		if tx.Hash.String() == req.TxHash {
			out.Found, toID = true, tx.ToID
			out.Transaction = &transaction{
				Hash: tx.Hash.String(), InnerHash: tx.InnerTransactionHash, ToID: tx.ToID,
				FeeCharged: tx.FeeCharged, IsFeeBump: tx.IsFeeBump, ResultCode: tx.ResultCode, Ledger: tx.LedgerNumber,
			}
		}
	}
	if !out.Found {
		return out
	}
	for p := range buf.GetTransactionsParticipants()[toID] {
		out.Participants = append(out.Participants, p)
	}
	sort.Strings(out.Participants)
	sort.Slice(out.Trustlines, func(i, j int) bool { return out.Trustlines[i].Account < out.Trustlines[j].Account })

	// Operation IDs of this transaction (TOID: tx id + op index).
	ops := map[int64]bool{}
	for _, op := range buf.GetOperations() {
		if op.ID&^0xFFF == toID {
			ops[op.ID] = true
		}
	}
	for _, sc := range buf.GetStateChanges() {
		if sc.ToID != toID {
			continue
		}
		s := stateChange{
			Category:    string(sc.StateChangeCategory),
			Reason:      string(sc.StateChangeReason),
			Account:     string(sc.AccountID),
			OperationID: sc.OperationID,
			Token:       sc.TokenID.String(),
			Amount:      sc.Amount.String,
			ToMuxedID:   sc.ToMuxedID.String,
			LimitNew:    sc.TrustlineLimitNew.String,
		}
		if sc.SignerAccountID.Valid {
			s.Signer = string(sc.SignerAccountID.SignerKeyBytea)
		}
		if sc.SignerWeightOld.Valid {
			s.SignerOld = &sc.SignerWeightOld.Int16
		}
		if sc.SignerWeightNew.Valid {
			s.SignerNew = &sc.SignerWeightNew.Int16
		}
		out.StateChanges = append(out.StateChanges, s)
	}
	for _, t := range buf.GetTrustlineChanges() {
		if ops[t.OperationID] {
			out.Trustlines = append(out.Trustlines, trustline{
				Account: t.AccountID, Asset: t.Asset, OperationID: t.OperationID, Operation: string(t.Operation),
				Balance: t.Balance, Limit: t.Limit, Flags: t.Flags,
			})
		}
	}
	for _, a := range buf.GetAccountChanges() {
		for _, p := range out.Participants {
			if a.AccountID == p {
				out.Accounts = append(out.Accounts, account{Account: a.AccountID, Operation: string(a.Operation), Balance: a.Balance})
			}
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
	ctx := context.Background()
	outs := make([]output, 0, len(reqs))
	for _, r := range reqs {
		outs = append(outs, run(ctx, r))
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(outs); err != nil {
		os.Exit(1)
	}
}
