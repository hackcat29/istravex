package lint

import (
	"go/ast"

	"golang.org/x/tools/go/analysis"
)

// IX001 flags memo text read in a function that never validates UTF-8.
//
// stellar-core accepts any 28 bytes as MEMO_TEXT; it does not check that they
// are valid UTF-8. Storing them in a TEXT/JSON column, or treating them as a Go
// string that must be valid UTF-8, fails or corrupts on real ledgers.
var IX001 = &analysis.Analyzer{
	Name: "IX001",
	Doc:  "memo text is passed through by stellar-core without UTF-8 validation",
	Run:  runIX001,
}

var utf8Guards = []string{"ValidString", "Valid", "ToValidUTF8", "ValidUTF8", "SanitizeUTF8"}

func runIX001(pass *analysis.Pass) (any, error) {
	funcBodies(pass, func(_ *ast.FuncDecl, body *ast.BlockStmt) {
		if mentions(body, utf8Guards...) {
			return
		}
		ast.Inspect(body, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if xdrMethod(pass.TypesInfo, sel, "Memo", "MustText", "GetText") || xdrField(pass.TypesInfo, sel, "Memo", "Text") {
				report(pass, sel.Sel.Pos(), "IX001", "memo text is not UTF-8 validated by stellar-core; check utf8.ValidString or store the raw bytes")
			}
			return true
		})
	})
	return nil, nil
}
