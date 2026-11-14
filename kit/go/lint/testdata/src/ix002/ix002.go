package ix002

import (
	"github.com/stellar/go-stellar-sdk/xdr"
)

func walk(v xdr.ScVal) int { // want `IX002: walk recurses over XDR values with no depth limit`
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
