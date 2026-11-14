package lint

import (
	"go/ast"
	"strings"

	"golang.org/x/tools/go/analysis"
)

// IX003 flags fee and fee-payer data read from the transaction envelope.
//
// For a fee-bump, the envelope's SourceAccount() is the inner transaction's
// source, not the account that paid. Fee() is the bid, not the charge
// (Soroban refunds settle after apply). The payer is the fee-bump fee
// account, and the charged amount is TransactionResult.FeeCharged.
//
// SourceAccount() is only flagged in fee logic: the function's name or body
// deals with fees. Elsewhere it is usually right; an operation without its
// own source runs as the inner transaction's source, fee-bump or not.
// (Calibrated on stellar/wallet-backend, where the broader form of this rule
// flagged two correct operation-source fallbacks.)
var IX003 = &analysis.Analyzer{
	Name: "IX003",
	Doc:  "fee payer or fee amount derived from the envelope",
	Run:  runIX003,
}

var feeBumpAware = []string{"IsFeeBump", "FeeBumpAccount", "FeeAccount", "FeeBump", "FeeBumpFee"}

func runIX003(pass *analysis.Pass) (any, error) {
	funcBodies(pass, func(decl *ast.FuncDecl, body *ast.BlockStmt) {
		aware := mentions(body, feeBumpAware...)
		readsCharge := mentions(body, "FeeCharged")
		feeContext := strings.Contains(strings.ToLower(decl.Name.Name), "fee") || mentionsContaining(body, "Fee", "fee")
		ast.Inspect(body, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			switch {
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
