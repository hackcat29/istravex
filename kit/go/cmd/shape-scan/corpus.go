package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"github.com/stellar/go-stellar-sdk/xdr"
)

// decoders for the XDR types corpus fixtures carry.
var decoders = map[string]func() any{
	"TransactionEnvelope":      func() any { return &xdr.TransactionEnvelope{} },
	"TransactionResult":        func() any { return &xdr.TransactionResult{} },
	"TransactionMeta":          func() any { return &xdr.TransactionMeta{} },
	"LedgerEntryData":          func() any { return &xdr.LedgerEntryData{} },
	"LedgerEntry":              func() any { return &xdr.LedgerEntry{} },
	"LedgerEntryChanges":       func() any { return &xdr.LedgerEntryChanges{} },
	"ScVal":                    func() any { return &xdr.ScVal{} },
	"LedgerCloseMeta":          func() any { return &xdr.LedgerCloseMeta{} },
	"LedgerHeaderHistoryEntry": func() any { return &xdr.LedgerHeaderHistoryEntry{} },
}

type fixtureCells struct {
	Fixture string   `json:"fixture"`
	CapIDs  []string `json:"cap_ids"`
	Cells   []string `json:"cells"`
}

// corpusCells decodes every file of every fixture under dir/fixtures and
// lists the cells each fixture exercises. Files a decoder must refuse are
// skipped.
func corpusCells(dir string) ([]fixtureCells, error) {
	manifests, err := filepath.Glob(filepath.Join(dir, "fixtures", "*", "manifest.json"))
	if err != nil {
		return nil, err
	}
	sort.Strings(manifests)
	var out []fixtureCells
	for _, mf := range manifests {
		raw, err := os.ReadFile(mf)
		if err != nil {
			return nil, err
		}
		var m struct {
			ID     string   `json:"id"`
			CapIDs []string `json:"cap_ids"`
			Files  []struct {
				Path    string `json:"path"`
				XdrType string `json:"xdr_type"`
				Expect  string `json:"expect"`
			} `json:"files"`
		}
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, fmt.Errorf("%s: %w", mf, err)
		}
		set := map[string]bool{}
		for _, f := range m.Files {
			if f.Expect == "decode_error" {
				continue
			}
			mk, ok := decoders[f.XdrType]
			if !ok {
				return nil, fmt.Errorf("%s: no decoder for %s", m.ID, f.XdrType)
			}
			b64, err := os.ReadFile(filepath.Join(filepath.Dir(mf), f.Path))
			if err != nil {
				return nil, err
			}
			bin, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(b64)))
			if err != nil {
				return nil, fmt.Errorf("%s/%s: %w", m.ID, f.Path, err)
			}
			v := mk()
			if err := xdr.SafeUnmarshal(bin, v); err != nil {
				return nil, fmt.Errorf("%s/%s: %w", m.ID, f.Path, err)
			}
			walk(reflect.ValueOf(v).Elem(), nil, func(c string) { set[c] = true })
		}
		cells := make([]string, 0, len(set))
		for c := range set {
			cells = append(cells, c)
		}
		sort.Strings(cells)
		out = append(out, fixtureCells{Fixture: m.ID, CapIDs: m.CapIDs, Cells: cells})
	}
	return out, nil
}
