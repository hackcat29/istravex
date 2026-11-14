package ix003

import (
	"github.com/stellar/go-stellar-sdk/xdr"
)

func feePayer(env xdr.TransactionEnvelope) xdr.MuxedAccount {
	return env.SourceAccount() // want `IX003: envelope SourceAccount is the inner source on fee-bumps`
}

func chargeTo(env xdr.TransactionEnvelope, feeCharged int64) (xdr.MuxedAccount, int64) {
	return env.SourceAccount(), feeCharged // want `IX003: envelope SourceAccount is the inner source on fee-bumps`
}

// Operation-source fallback (as in wallet-backend): correct, not flagged.
func opSource(env xdr.TransactionEnvelope, own *xdr.MuxedAccount) xdr.MuxedAccount {
	if own != nil {
		return *own
	}
	return env.SourceAccount()
}

func payerAware(env xdr.TransactionEnvelope) xdr.MuxedAccount {
	if env.IsFeeBump() {
		return env.FeeBumpAccount()
	}
	return env.SourceAccount()
}

func fee(env xdr.TransactionEnvelope) uint32 {
	return env.Fee() // want `IX003: envelope fee is the bid`
}

func feeCharged(env xdr.TransactionEnvelope, r xdr.TransactionResult) int64 {
	if r.FeeCharged > 0 {
		return r.FeeCharged
	}
	return int64(env.Fee())
}
