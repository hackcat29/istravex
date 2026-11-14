package lint

import (
	"go/ast"
	"go/token"
	"go/types"

	"golang.org/x/tools/go/analysis"
)

// IX002 flags walks over recursive XDR values (ScVal and its containers,
// Soroban authorization invocation trees) with no depth or size limit.
// stellar-core validates neither: a transaction's authorization tree and the
// ScVals inside it are as deep and as wide as its submitter made them, within
// the transaction size limit.
//
//   - Recursion: a function that takes a recursive XDR value and calls itself
//     must take an integer (depth, budget) and compare it against a bound.
//     XDR decoding bounds depth, but a value built or decoded elsewhere can
//     still nest deeply enough to exhaust the stack.
//   - Explicit stacks: a loop that pushes SubInvocations (or a vec's or map's
//     elements) onto a work list trades the stack for the heap; it still needs
//     a bound on depth or on the number of nodes visited.
var IX002 = &analysis.Analyzer{
	Name: "IX002",
	Doc:  "walks over recursive XDR values (ScVal, authorization trees) without a depth or size limit",
	Run:  runIX002,
}

var recursiveXdr = []string{"ScVal", "ScVec", "ScMap", "ScMapEntry", "SorobanAuthorizedInvocation", "SorobanAuthorizedFunction"}

func runIX002(pass *analysis.Pass) (any, error) {
	funcBodies(pass, func(decl *ast.FuncDecl, body *ast.BlockStmt) {
		obj, _ := pass.TypesInfo.Defs[decl.Name].(*types.Func)
		if obj == nil {
			return
		}
		checkWorklists(pass, body)
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
		report(pass, decl.Name.Pos(), "IX002", decl.Name.Name+" recurses over XDR values with no depth or size limit; add a depth (or node budget) parameter and stop past a bound")
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

// checkWorklists flags loops that push children of a recursive XDR value onto
// a work list (append(stack, x.SubInvocations...) and the like) when the
// function never compares an integer against a bound other than a length.
func checkWorklists(pass *analysis.Pass, body *ast.BlockStmt) {
	if comparesCounter(body) {
		return
	}
	ast.Inspect(body, func(n ast.Node) bool {
		loop, ok := n.(*ast.ForStmt)
		if !ok {
			return true
		}
		ast.Inspect(loop.Body, func(m ast.Node) bool {
			call, ok := m.(*ast.CallExpr)
			if !ok {
				return true
			}
			if id, ok := call.Fun.(*ast.Ident); !ok || id.Name != "append" {
				return true
			}
			for _, a := range call.Args[1:] {
				if sel, ok := ast.Unparen(a).(*ast.SelectorExpr); ok && xdrField(pass.TypesInfo, sel, "SorobanAuthorizedInvocation", "SubInvocations") {
					report(pass, call.Pos(), "IX002", "work list over authorization subinvocations with no depth or size limit; count nodes or depth and stop past a bound")
					return false
				}
				if tv, ok := pass.TypesInfo.Types[a]; ok && xdrNamed(tv.Type, "ScVal", "ScMapEntry") && call.Ellipsis.IsValid() {
					report(pass, call.Pos(), "IX002", "work list over ScVal elements with no depth or size limit; count nodes or depth and stop past a bound")
					return false
				}
			}
			return true
		})
		return true
	})
}

// comparesCounter reports whether body has an ordered comparison of an
// identifier (a depth or node counter) that isn't a len(...) call.
func comparesCounter(body ast.Node) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		be, ok := n.(*ast.BinaryExpr)
		if !ok || found {
			return !found
		}
		switch be.Op {
		case token.GTR, token.GEQ, token.LSS, token.LEQ:
		default:
			return true
		}
		for _, side := range []ast.Expr{be.X, be.Y} {
			if _, ok := ast.Unparen(side).(*ast.Ident); ok {
				found = true
			}
		}
		return true
	})
	return found
}
