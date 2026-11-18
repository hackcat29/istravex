package main

import (
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/stellar/go-stellar-sdk/xdr"
)

// A cell is one arm of one XDR union, named "<Union>:<ARM>", for example
// "ScAddress:SC_ADDRESS_TYPE_MUXED_ACCOUNT" or "LedgerEntryExt:v1". Flag bits
// that change what a reader must do (trustline authorization levels,
// clawback) are cells too, named "<Type>.flags:<FLAG>". The set of cells is
// the schema's surface: a corpus covers a cell when one of its values takes
// that arm.

type union interface {
	SwitchFieldName() string
	ArmForSwitch(int32) (string, bool)
}

var unionIface = reflect.TypeOf((*union)(nil)).Elem()

// screaming turns a Go enum constant name into the XDR spelling:
// ScAddressTypeScAddressTypeMuxedAccount → SC_ADDRESS_TYPE_MUXED_ACCOUNT.
func screaming(enumType, goName string) string {
	s := strings.TrimPrefix(goName, enumType)
	var b strings.Builder
	for i, r := range s {
		if i > 0 && r >= 'A' && r <= 'Z' {
			prev := rune(s[i-1])
			next := rune(0)
			if i+1 < len(s) {
				next = rune(s[i+1])
			}
			if (prev >= 'a' && prev <= 'z') || (prev >= '0' && prev <= '9') || (next >= 'a' && next <= 'z') {
				b.WriteByte('_')
			}
		}
		b.WriteRune(r)
	}
	return strings.ToUpper(b.String())
}

// armName is the cell name for a union value's current arm.
func armName(v reflect.Value) (string, bool) {
	u := v.Interface().(union)
	sw := v.FieldByName(u.SwitchFieldName())
	if !sw.IsValid() {
		return "", false
	}
	return discName(sw)
}

func discName(sw reflect.Value) (string, bool) {
	if s, ok := sw.Interface().(fmt.Stringer); ok && sw.Kind() == reflect.Int32 && sw.Type().Name() != "Int32" {
		name := s.String()
		if name == "" {
			return "", false
		}
		return screaming(sw.Type().Name(), name), true
	}
	switch sw.Kind() {
	case reflect.Int32, reflect.Int, reflect.Int64:
		return fmt.Sprintf("v%d", sw.Int()), true
	case reflect.Uint32, reflect.Uint, reflect.Uint64:
		return fmt.Sprintf("v%d", sw.Uint()), true
	}
	return "", false
}

// universe lists every cell of every union, by probing each union's arms.
func universe() []string {
	set := map[string]bool{}
	for _, z := range unions {
		t := reflect.TypeOf(z)
		u := z.(union)
		f, ok := t.FieldByName(u.SwitchFieldName())
		if !ok {
			continue
		}
		for sw := int32(-128); sw <= 128; sw++ {
			if _, ok := u.ArmForSwitch(sw); !ok {
				continue
			}
			d := reflect.New(f.Type).Elem()
			switch d.Kind() {
			case reflect.Int32, reflect.Int, reflect.Int64:
				d.SetInt(int64(sw))
			case reflect.Uint32, reflect.Uint, reflect.Uint64:
				if sw < 0 {
					continue
				}
				d.SetUint(uint64(sw))
			}
			if n, ok := discName(d); ok {
				set[t.Name()+":"+n] = true
			}
		}
	}
	for _, c := range flagCells {
		set[c] = true
	}
	out := make([]string, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

// Flag bits a reader has to interpret, as cells.
var flagCells = []string{
	"AccountEntry.flags:AUTH_REQUIRED_FLAG",
	"AccountEntry.flags:AUTH_REVOCABLE_FLAG",
	"AccountEntry.flags:AUTH_IMMUTABLE_FLAG",
	"AccountEntry.flags:AUTH_CLAWBACK_ENABLED_FLAG",
	"TrustLineEntry.flags:AUTHORIZED_FLAG",
	"TrustLineEntry.flags:AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG",
	"TrustLineEntry.flags:TRUSTLINE_CLAWBACK_ENABLED_FLAG",
	"ClaimableBalanceEntry.flags:CLAIMABLE_BALANCE_CLAWBACK_ENABLED_FLAG",
}

func flags(v reflect.Value, record func(string)) {
	switch x := v.Interface().(type) {
	case xdr.AccountEntry:
		names := []string{"AUTH_REQUIRED_FLAG", "AUTH_REVOCABLE_FLAG", "AUTH_IMMUTABLE_FLAG", "AUTH_CLAWBACK_ENABLED_FLAG"}
		for i, n := range names {
			if uint32(x.Flags)&(1<<i) != 0 {
				record("AccountEntry.flags:" + n)
			}
		}
	case xdr.TrustLineEntry:
		names := []string{"AUTHORIZED_FLAG", "AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG", "TRUSTLINE_CLAWBACK_ENABLED_FLAG"}
		for i, n := range names {
			if uint32(x.Flags)&(1<<i) != 0 {
				record("TrustLineEntry.flags:" + n)
			}
		}
	case xdr.ClaimableBalanceEntry:
		if x.Ext.V == 1 && x.Ext.V1 != nil && uint32(x.Ext.V1.Flags)&1 != 0 {
			record("ClaimableBalanceEntry.flags:CLAIMABLE_BALANCE_CLAWBACK_ENABLED_FLAG")
		}
	}
}

var skipTypes = map[reflect.Type]bool{}

// walk records the cells of every union reachable from v. Values whose type is
// in skip are not entered (the ledger-level walk leaves transactions out).
func walk(v reflect.Value, skip map[reflect.Type]bool, record func(string)) {
	var visit func(v reflect.Value, depth int)
	nodes := 0
	visit = func(v reflect.Value, depth int) {
		if depth > 400 || nodes > 5_000_000 {
			return
		}
		nodes++
		switch v.Kind() {
		case reflect.Ptr, reflect.Interface:
			if !v.IsNil() {
				visit(v.Elem(), depth+1)
			}
			return
		case reflect.Slice, reflect.Array:
			if v.Type().Elem().Kind() == reflect.Uint8 {
				return
			}
			for i := 0; i < v.Len(); i++ {
				visit(v.Index(i), depth+1)
			}
			return
		case reflect.Struct:
		default:
			return
		}
		if skip[v.Type()] {
			return
		}
		if v.Type().Implements(unionIface) {
			if n, ok := armName(v); ok {
				record(v.Type().Name() + ":" + n)
			}
		}
		flags(v, record)
		for i := 0; i < v.NumField(); i++ {
			if v.Type().Field(i).IsExported() {
				visit(v.Field(i), depth+1)
			}
		}
	}
	visit(v, 0)
}
