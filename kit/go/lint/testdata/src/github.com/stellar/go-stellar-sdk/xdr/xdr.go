// Package xdr is a minimal stand-in for the real package, for analyzer tests.
package xdr

type Memo struct{ Text *string }

func (m Memo) MustText() string        { return *m.Text }
func (m Memo) GetText() (string, bool) { return *m.Text, true }

type MuxedAccount struct{}
type TransactionEnvelope struct{}

func (e TransactionEnvelope) SourceAccount() MuxedAccount  { return MuxedAccount{} }
func (e TransactionEnvelope) Fee() uint32                  { return 0 }
func (e TransactionEnvelope) IsFeeBump() bool              { return false }
func (e TransactionEnvelope) FeeBumpAccount() MuxedAccount { return MuxedAccount{} }
func (e TransactionEnvelope) Memo() Memo                   { return Memo{} }

type ScVal struct{ Vec **ScVec }
type ScVec []ScVal

type TransactionResult struct{ FeeCharged int64 }
