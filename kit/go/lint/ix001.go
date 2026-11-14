package lint

import (
	"go/ast"
	"go/types"

	"golang.org/x/tools/go/analysis"
)

// IX001 flags fields stellar-core passes through without validating, used as
// if they had been validated.
//
//   - Memo text. stellar-core accepts any 28 bytes as MEMO_TEXT; it does not
//     check that they are valid UTF-8. Storing them in a TEXT/JSON column, or
//     treating them as a Go string that must be valid UTF-8, fails or corrupts
//     on real ledgers.
//   - Muxed account IDs. Any uint64 is valid. Converting one to a float or a
//     narrower or signed integer silently changes it above 2^53 (float64) or
//     2^63 (int64), so a deposit is attributed to a different sub-account.
//
// (Soroban authorization trees, the third unvalidated field, are IX002's.)
var IX001 = &analysis.Analyzer{
	Name: "IX001",
	Doc:  "fields stellar-core passes through unvalidated (memo text, muxed IDs) used as if validated",
	Run:  runIX001,
}

var utf8Guards = []string{"ValidString", "Valid", "ToValidUTF8", "ValidUTF8", "SanitizeUTF8"}

func runIX001(pass *analysis.Pass) (any, error) {
	funcBodies(pass, func(_ *ast.FuncDecl, body *ast.BlockStmt) {
		guarded := mentions(body, utf8Guards...)
		ids := muxedIDVars(pass.TypesInfo, body)
		ast.Inspect(body, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.SelectorExpr:
				if !guarded && (xdrMethod(pass.TypesInfo, x, "Memo", "MustText", "GetText") || xdrField(pass.TypesInfo, x, "Memo", "Text")) {
					report(pass, x.Sel.Pos(), "IX001", "memo text is not UTF-8 validated by stellar-core; check utf8.ValidString or store the raw bytes")
				}
			case *ast.CallExpr:
				// A type conversion T(id) of a muxed ID to a lossy type.
				if len(x.Args) != 1 || !lossyTarget(pass.TypesInfo, x.Fun) || !isMuxedID(pass.TypesInfo, x.Args[0], ids) {
					return true
				}
				report(pass, x.Pos(), "IX001", "muxed IDs use the full uint64 range; this conversion changes IDs above 2^53 or 2^63. Keep a uint64 or a decimal string")
			}
			return true
		})
	})
	return nil, nil
}

// lossyTarget reports whether fun names a type that can't hold every uint64.
func lossyTarget(info *types.Info, fun ast.Expr) bool {
	tv, ok := info.Types[fun]
	if !ok || !tv.IsType() {
		return false
	}
	b, ok := tv.Type.Underlying().(*types.Basic)
	if !ok {
		return false
	}
	switch b.Kind() {
	case types.Float32, types.Float64, types.Int, types.Int64, types.Int32, types.Uint32:
		return true
	}
	return false
}

// muxedIDVars returns the variables a function assigns a muxed ID to
// (id, err := m.GetId(); id := m.Med25519.Id).
func muxedIDVars(info *types.Info, body ast.Node) map[types.Object]bool {
	vars := map[types.Object]bool{}
	ast.Inspect(body, func(n ast.Node) bool {
		as, ok := n.(*ast.AssignStmt)
		if !ok || len(as.Rhs) != 1 || len(as.Lhs) == 0 {
			return true
		}
		if !isMuxedID(info, as.Rhs[0], nil) {
			return true
		}
		if id, ok := as.Lhs[0].(*ast.Ident); ok {
			if obj := info.Defs[id]; obj != nil {
				vars[obj] = true
			} else if obj := info.Uses[id]; obj != nil {
				vars[obj] = true
			}
		}
		return true
	})
	return vars
}

// isMuxedID reports whether e is a muxed account ID: MuxedAccount.GetId() /
// MustId(), or the Id field of MuxedAccountMed25519.
func isMuxedID(info *types.Info, e ast.Expr, vars map[types.Object]bool) bool {
	e = ast.Unparen(e)
	if id, ok := e.(*ast.Ident); ok && vars[info.Uses[id]] {
		return true
	}
	if call, ok := e.(*ast.CallExpr); ok {
		if sel, ok := call.Fun.(*ast.SelectorExpr); ok && xdrMethod(info, sel, "MuxedAccount", "GetId", "MustId") {
			return true
		}
	}
	if sel, ok := e.(*ast.SelectorExpr); ok && xdrField(info, sel, "MuxedAccountMed25519", "Id") {
		return true
	}
	return false
}
