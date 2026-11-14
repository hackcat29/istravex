package ix002

import (
	"github.com/stellar/go-stellar-sdk/xdr"
)

func walk(v xdr.ScVal) int { // want `IX002: walk recurses over XDR values with no depth or size limit`
	n := 1
	if v.Vec != nil {
		for _, c := range **v.Vec {
			n += walk(c)
		}
	}
	return n
}

func walkBounded(v xdr.ScVal, depth int) int {
	if depth > 64 {
		return 0
	}
	n := 1
	if v.Vec != nil {
		for _, c := range **v.Vec {
			n += walkBounded(c, depth+1)
		}
	}
	return n
}

func notRecursive(v xdr.ScVal) bool { return v.Vec != nil }

func walkAuth(root xdr.SorobanAuthorizedInvocation) int {
	stack := []xdr.SorobanAuthorizedInvocation{root}
	n := 0
	for len(stack) > 0 {
		inv := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		n++
		stack = append(stack, inv.SubInvocations...) // want `IX002: work list over authorization subinvocations`
	}
	return n
}

func walkAuthBounded(root xdr.SorobanAuthorizedInvocation) int {
	stack := []xdr.SorobanAuthorizedInvocation{root}
	n := 0
	for len(stack) > 0 {
		if n > 1000 {
			return n
		}
		inv := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		n++
		stack = append(stack, inv.SubInvocations...)
	}
	return n
}
