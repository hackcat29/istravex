// Package selftest contains deliberate ingestion mistakes, one or more per
// rule. CI runs the istravex-lint action over it and requires exactly these
// findings.
package selftest

import "github.com/stellar/go-stellar-sdk/xdr"

// MemoText returns memo text without UTF-8 validation (IX001).
func MemoText(m xdr.Memo) string {
	return m.MustText()
}

// MuxedID stores a muxed ID as a float (IX001).
func MuxedID(m xdr.MuxedAccount) float64 {
	id, _ := m.GetId()
	return float64(id)
}

// CountValues walks an ScVal with no depth limit (IX002).
func CountValues(v xdr.ScVal) int {
	n := 1
	if vec, ok := v.GetVec(); ok && vec != nil {
		for _, c := range *vec {
			n += CountValues(c)
		}
	}
	return n
}

// FeePayer reads the payer and fee from the envelope (IX003, twice).
func FeePayer(env xdr.TransactionEnvelope) (string, uint32) {
	src := env.SourceAccount()
	return src.Address(), env.Fee()
}

// Participants records the source in its M… form (IX003).
func Participants(env xdr.TransactionEnvelope) []string {
	src := env.SourceAccount()
	return []string{src.Address()}
}
