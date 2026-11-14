package ix001

import (
	"unicode/utf8"

	"github.com/stellar/go-stellar-sdk/xdr"
)

func storeMemo(env xdr.TransactionEnvelope) string {
	return env.Memo().MustText() // want `IX001: memo text is not UTF-8 validated`
}

func storeMemoField(m xdr.Memo) string {
	return *m.Text // want `IX001: memo text is not UTF-8 validated`
}

func storeMemoChecked(env xdr.TransactionEnvelope) string {
	t := env.Memo().MustText()
	if !utf8.ValidString(t) {
		return ""
	}
	return t
}

func storeMemoIgnored(env xdr.TransactionEnvelope) string {
	return env.Memo().MustText() //ixlint:ignore IX001 stored as bytea
}
