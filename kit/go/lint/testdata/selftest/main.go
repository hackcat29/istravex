// Package selftest contains deliberate ingestion mistakes. CI runs the
// istravex-lint action over it and requires the action to fail.
package selftest

import "github.com/stellar/go-stellar-sdk/xdr"

// MemoText returns memo text without UTF-8 validation (IX001).
func MemoText(m xdr.Memo) string {
	return m.MustText()
}

// FeePayer reads the payer and fee from the envelope (IX003, twice).
func FeePayer(env xdr.TransactionEnvelope) (string, uint32) {
	src := env.SourceAccount()
	return src.Address(), env.Fee()
}
