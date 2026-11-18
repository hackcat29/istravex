package main

import (
	"bufio"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"github.com/hackcat29/istravex/kit/go/internal/xdrtypes"
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

// casesCells decodes every valid generated case and lists the cells they
// exercise together, with how many cases reach each.
func casesCells(path string) (map[string]int, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, 0, err
	}
	counts := map[string]int{}
	n := 0
	sc := bufio.NewScanner(gz)
	sc.Buffer(make([]byte, 1<<20), 1<<26)
	for sc.Scan() {
		var c struct{ Type, Kind, B64 string }
		if err := json.Unmarshal(sc.Bytes(), &c); err != nil {
			return nil, 0, err
		}
		if c.Kind != "valid" {
			continue
		}
		mk, ok := xdrtypes.ByName[strings.ToLower(c.Type)]
		if !ok {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(c.B64)
		if err != nil {
			return nil, 0, err
		}
		v := mk()
		if err := xdr.SafeUnmarshal(raw, v); err != nil {
			continue
		}
		n++
		seen := map[string]bool{}
		walk(reflect.ValueOf(v).Elem(), nil, func(cell string) { seen[cell] = true })
		for cell := range seen {
			counts[cell]++
		}
	}
	return counts, n, sc.Err()
}
