// Package lint holds the Istravex ingestion analyzers for Go indexers built on
// the Stellar XDR packages (github.com/stellar/go-stellar-sdk/xdr and the
// older github.com/stellar/go/xdr).
//
//	IX001 unvalidated fields used as if validated: memo text without a UTF-8
//	      check, muxed IDs converted to a type that can't hold every uint64
//	IX002 walks over recursive XDR values (ScVal, authorization trees) with no
//	      depth or size limit, recursive or with an explicit work list
//	IX003 participants or fees from the envelope: a muxed account's M… form
//	      as a participant, the inner source or the bid as the fee
//
// Suppress a finding with a `//ixlint:ignore IX00n reason` comment on the line
// above or at the end of the reported line.
package lint

import (
	"go/ast"
	"go/token"
	"go/types"
	"strings"

	"golang.org/x/tools/go/analysis"
)

var xdrPaths = map[string]bool{
	"github.com/stellar/go-stellar-sdk/xdr": true,
	"github.com/stellar/go/xdr":             true,
}

// Analyzers is the full rule set.
var Analyzers = []*analysis.Analyzer{IX001, IX002, IX003}

// xdrNamed reports whether t (or *t, or []t) is the named XDR type name.
func xdrNamed(t types.Type, names ...string) bool {
	for {
		switch u := t.(type) {
		case *types.Pointer:
			t = u.Elem()
			continue
		case *types.Slice:
			t = u.Elem()
			continue
		case *types.Alias:
			t = types.Unalias(u)
			continue
		}
		break
	}
	n, ok := t.(*types.Named)
	if !ok || n.Obj().Pkg() == nil || !xdrPaths[n.Obj().Pkg().Path()] {
		return false
	}
	for _, name := range names {
		if n.Obj().Name() == name {
			return true
		}
	}
	return false
}

// xdrMethod reports whether sel is a call target method `name` on XDR type `recv`.
func xdrMethod(info *types.Info, sel *ast.SelectorExpr, recv string, names ...string) bool {
	s := info.Selections[sel]
	if s == nil || s.Kind() != types.MethodVal {
		return false
	}
	for _, n := range names {
		if sel.Sel.Name == n && xdrNamed(s.Recv(), recv) {
			return true
		}
	}
	return false
}

// xdrField reports whether sel reads field `name` of XDR type `recv`.
func xdrField(info *types.Info, sel *ast.SelectorExpr, recv, name string) bool {
	s := info.Selections[sel]
	return s != nil && s.Kind() == types.FieldVal && sel.Sel.Name == name && xdrNamed(s.Recv(), recv)
}

// funcBodies yields every function body (declarations and literals) with its
// enclosing declaration, so rules can reason per function.
func funcBodies(pass *analysis.Pass, fn func(decl *ast.FuncDecl, body *ast.BlockStmt)) {
	for _, f := range pass.Files {
		for _, d := range f.Decls {
			if fd, ok := d.(*ast.FuncDecl); ok && fd.Body != nil {
				fn(fd, fd.Body)
			}
		}
	}
}

// mentions reports whether body references any identifier or selector named one of names.
func mentions(body ast.Node, names ...string) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		if found {
			return false
		}
		var name string
		switch x := n.(type) {
		case *ast.Ident:
			name = x.Name
		case *ast.SelectorExpr:
			name = x.Sel.Name
		default:
			return true
		}
		for _, want := range names {
			if name == want {
				found = true
			}
		}
		return true
	})
	return found
}

// suppressed reports whether an `//ixlint:ignore <rule>` comment covers pos.
func suppressed(pass *analysis.Pass, pos token.Pos, rule string) bool {
	p := pass.Fset.Position(pos)
	for _, f := range pass.Files {
		if pass.Fset.Position(f.Pos()).Filename != p.Filename {
			continue
		}
		for _, cg := range f.Comments {
			for _, c := range cg.List {
				cp := pass.Fset.Position(c.Pos())
				if (cp.Line == p.Line || cp.Line == p.Line-1) && strings.Contains(c.Text, "ixlint:ignore") && strings.Contains(c.Text, rule) {
					return true
				}
			}
		}
	}
	return false
}

func report(pass *analysis.Pass, pos token.Pos, rule, msg string) {
	if !suppressed(pass, pos, rule) {
		pass.Reportf(pos, "%s: %s", rule, msg)
	}
}
