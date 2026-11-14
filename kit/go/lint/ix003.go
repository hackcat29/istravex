package lint

import (
	"go/ast"
	"strings"

	"golang.org/x/tools/go/analysis"
)

// IX003 flags participants and fees derived from what the envelope says
// instead of what the ledger records.
//
// Participants. A muxed account's Address() (and GetAddress()) is its M…
// form. A participant is an account: the same account as G… and M… is two
// identities, and an M… address doesn't fit a 32-byte account key. In
// stellar/wallet-backend this halted ingestion (#716, fixed in #753): a
// Soroban operation from a muxed source added the M… form next to the G…
// one, and both encoded to one primary key. Flagged in participant code (the
// function's name or body mentions participants); elsewhere the M… form is
// often exactly what's wanted, e.g. to display or store the muxed address.
//
// Fees. For a fee-bump, the envelope's SourceAccount() is the inner
// transaction's source, not the account that paid; Fee() is the bid, not the
// charge (Soroban refunds settle after apply). The payer is the fee-bump fee
// account, and the charged amount is TransactionResult.FeeCharged.
// SourceAccount() is only flagged in fee logic: elsewhere it is usually
// right; an operation without its own source runs as the inner transaction's
// source, fee-bump or not. (Calibrated on stellar/wallet-backend, where the
// broader form flagged two correct operation-source fallbacks.)
var IX003 = &analysis.Analyzer{
	Name: "IX003",
	Doc:  "participants or fees derived from the envelope instead of the ledger's accounts and charges",
	Run:  runIX003,
}

var feeBumpAware = []string{"IsFeeBump", "FeeBumpAccount", "FeeAccount", "FeeBump", "FeeBumpFee"}

func runIX003(pass *analysis.Pass) (any, error) {
	funcBodies(pass, func(decl *ast.FuncDecl, body *ast.BlockStmt) {
		aware := mentions(body, feeBumpAware...)
		readsCharge := mentions(body, "FeeCharged")
		feeContext := strings.Contains(strings.ToLower(decl.Name.Name), "fee") || mentionsContaining(body, "Fee", "fee")
		participantContext := strings.Contains(strings.ToLower(decl.Name.Name), "participant") || mentionsContaining(body, "articipant")
		ast.Inspect(body, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			switch {
			case participantContext && xdrMethod(pass.TypesInfo, sel, "MuxedAccount", "Address", "GetAddress"):
				report(pass, sel.Sel.Pos(), "IX003", "a muxed account's Address() is its M… form; a participant is the account: use ToAccountId().Address()")
			case feeContext && !aware && xdrMethod(pass.TypesInfo, sel, "TransactionEnvelope", "SourceAccount"):
				report(pass, sel.Sel.Pos(), "IX003", "envelope SourceAccount is the inner source on fee-bumps; the payer is FeeBumpAccount (check IsFeeBump)")
			case !readsCharge && xdrMethod(pass.TypesInfo, sel, "TransactionEnvelope", "Fee", "FeeBumpFee"):
				report(pass, sel.Sel.Pos(), "IX003", "envelope fee is the bid; the charged fee is TransactionResult.FeeCharged")
			}
			return true
		})
	})
	return nil, nil
}

// mentionsContaining reports whether body references an identifier whose name
// contains any of the substrings.
func mentionsContaining(body ast.Node, subs ...string) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		id, ok := n.(*ast.Ident)
		if !ok || found {
			return !found
		}
		for _, s := range subs {
			if strings.Contains(id.Name, s) {
				found = true
			}
		}
		return true
	})
	return found
}
