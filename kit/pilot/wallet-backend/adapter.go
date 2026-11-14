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
// what ingestion would hand to persistence. It also runs every column encoder
// persistence would run (each field's driver.Valuer, and the participants'
// AddressBytea keys): a value that can't be encoded, or two participants that
// encode to the same key, halts real ingestion, so they're reported as
// persist_errors.
//
//	go run -tags istravex_pilot ./istravex_pilot < requests.json
package main

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"sort"
	"time"

	"github.com/alitto/pond/v2"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/stellar/go-stellar-sdk/ingest/ledgerbackend"

	"github.com/stellar/wallet-backend/internal/indexer"
	"github.com/stellar/wallet-backend/internal/indexer/types"
	"github.com/stellar/wallet-backend/internal/ingest"
	"github.com/stellar/wallet-backend/internal/metrics"
)

type request struct {
	Fixture    string `json:"fixture"`
	RPCURL     string `json:"rpc_url"`
	Passphrase string `json:"passphrase"`
	Ledger     uint32 `json:"ledger"`
	TxHash     string `json:"tx_hash"`
	// Datastore mode: read the ledger from a data lake through wallet-backend's
	// S3 datastore backend instead of RPC (kit/datalake/lake.mjs serve).
	BucketPath  string `json:"bucket_path,omitempty"`
	EndpointURL string `json:"endpoint_url,omitempty"`
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
	// Encoding failures persistence would hit; any one halts ingestion at this ledger.
	PersistErrors []string `json:"persist_errors"`
}

// encodeErrors calls Value() on every field of v that implements driver.Valuer,
// as a database COPY would, and returns the errors.
func encodeErrors(label string, v any) []string {
	var errs []string
	rv := reflect.ValueOf(v)
	for rv.Kind() == reflect.Pointer {
		if rv.IsNil() {
			return nil
		}
		rv = rv.Elem()
	}
	if rv.Kind() != reflect.Struct {
		return nil
	}
	valuer := reflect.TypeOf((*driver.Valuer)(nil)).Elem()
	for i := 0; i < rv.NumField(); i++ {
		f := rv.Field(i)
		if !rv.Type().Field(i).IsExported() {
			continue
		}
		var val driver.Valuer
		switch {
		case f.Type().Implements(valuer):
			val, _ = f.Interface().(driver.Valuer)
		case f.CanAddr() && f.Addr().Type().Implements(valuer):
			val, _ = f.Addr().Interface().(driver.Valuer)
		}
		if val == nil {
			continue
		}
		if _, err := val.Value(); err != nil {
			errs = append(errs, fmt.Sprintf("%s.%s: %v", label, rv.Type().Field(i).Name, err))
		}
	}
	return errs
}

func run(ctx context.Context, req request) output {
	out := output{Fixture: req.Fixture, Participants: []string{}, StateChanges: []stateChange{}, Trustlines: []trustline{}, Accounts: []account{}, PersistErrors: []string{}}
	cfg := ingest.Configs{
		LedgerBackendType: ingest.LedgerBackendTypeRPC,
		RPCURL:            req.RPCURL,
		GetLedgersLimit:   1,
		NetworkPassphrase: req.Passphrase,
	}
	if req.BucketPath != "" {
		cfg.LedgerBackendType = ingest.LedgerBackendTypeDatastore
		cfg.Datastore = ingest.DatastoreConfig{
			BucketPath: req.BucketPath, EndpointURL: req.EndpointURL, Region: "us-east-1",
			BufferSize: 1, NumWorkers: 1, RetryLimit: 1, RetryWait: time.Second,
		}
	}
	backend, err := ingest.NewLedgerBackend(ctx, cfg)
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
	// Participants are stored as AddressBytea keys: each must encode, and no
	// two may encode to the same key (a duplicate primary key halts the COPY).
	keys := map[string]string{}
	for _, p := range out.Participants {
		k, err := types.AddressBytea(p).Value()
		if err != nil {
			out.PersistErrors = append(out.PersistErrors, fmt.Sprintf("participant %s: %v", p, err))
			continue
		}
		key := fmt.Sprint(k)
		if other, dup := keys[key]; dup {
			out.PersistErrors = append(out.PersistErrors, fmt.Sprintf("participants %s and %s encode to the same key", other, p))
		}
		keys[key] = p
	}
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
		out.PersistErrors = append(out.PersistErrors, encodeErrors("state_change", sc)...)
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
