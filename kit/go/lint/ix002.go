package lint

import (
	"go/ast"
	"go/token"
	"go/types"

	"golang.org/x/tools/go/analysis"
)

// IX002 flags functions that recurse over recursive XDR values (ScVal and its
// containers, Soroban auth invocation trees) without a depth parameter that is
// compared against a limit. XDR decoding bounds depth, but a value built or
// decoded elsewhere can still nest deeply enough to exhaust the stack.
var IX002 = &analysis.Analyzer{
	Name: "IX002",
	Doc:  "recursion over recursive XDR values without a depth limit",
	Run:  runIX002,
}

var recursiveXdr = []string{"ScVal", "ScVec", "ScMap", "ScMapEntry", "SorobanAuthorizedInvocation", "SorobanAuthorizedFunction"}

func runIX002(pass *analysis.Pass) (any, error) {
	funcBodies(pass, func(decl *ast.FuncDecl, body *ast.BlockStmt) {
		obj, _ := pass.TypesInfo.Defs[decl.Name].(*types.Func)
		if obj == nil {
			return
		}
		sig := obj.Type().(*types.Signature)
		walksXdr := false
		var ints []*types.Var
		for i := 0; i < sig.Params().Len(); i++ {
			p := sig.Params().At(i)
			if xdrNamed(p.Type(), recursiveXdr...) {
				walksXdr = true
			}
			if b, ok := p.Type().Underlying().(*types.Basic); ok && b.Info()&types.IsInteger != 0 {
				ints = append(ints, p)
			}
		}
		if !walksXdr || !callsSelf(pass.TypesInfo, body, obj) || comparesAny(pass.TypesInfo, body, ints) {
			return
		}
		report(pass, decl.Name.Pos(), "IX002", decl.Name.Name+" recurses over XDR values with no depth limit; add a depth parameter and stop past a bound")
	})
	return nil, nil
}

func callsSelf(info *types.Info, body ast.Node, fn *types.Func) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || found {
			return !found
		}
		var id *ast.Ident
		switch f := call.Fun.(type) {
		case *ast.Ident:
			id = f
		case *ast.SelectorExpr:
			id = f.Sel
		}
		if id != nil && info.Uses[id] == fn {
			found = true
		}
		return true
	})
	return found
}

// comparesAny reports whether any of vars appears in an ordered comparison.
func comparesAny(info *types.Info, body ast.Node, vars []*types.Var) bool {
	if len(vars) == 0 {
		return false
	}
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		be, ok := n.(*ast.BinaryExpr)
		if !ok || found {
			return !found
		}
		switch be.Op {
		case token.GTR, token.GEQ, token.LSS, token.LEQ, token.EQL:
		default:
			return true
		}
		for _, side := range []ast.Expr{be.X, be.Y} {
			if id, ok := ast.Unparen(side).(*ast.Ident); ok {
				for _, v := range vars {
					if info.Uses[id] == v {
						found = true
					}
				}
			}
		}
		return true
	})
	return found
}
