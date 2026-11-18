// Command cases runs the generated cases through go-stellar-sdk: every valid
// case must decode and re-encode byte for byte; every hostile one (trailing
// bytes, truncation, a bad first word) must be refused. Decoding uses
// xdr.SafeUnmarshal, which also requires every byte to be consumed.
//
//	go run ./cmd/cases ../../corpus/generated/cases.jsonl.gz > ../../corpus/results/cases-go.json
package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"runtime/debug"
	"sort"
	"strings"

	"github.com/stellar/go-stellar-sdk/xdr"
)

type kind struct {
	Cases     int `json:"cases"`
	Supported int `json:"supported"`
	Passed    int `json:"passed"`
}

type failure struct {
	Type string `json:"type"`
	Kind string `json:"kind"`
	B64  string `json:"b64"`
}

type marshaler interface{ MarshalBinary() ([]byte, error) }

func outcome(t, k, b64 string) (result string) {
	mk, ok := types[strings.ToLower(t)]
	if !ok {
		return "unsupported"
	}
	defer func() {
		// A decoder that panics on hostile input fails the case.
		if r := recover(); r != nil {
			result = "fail"
		}
	}()
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "fail"
	}
	v := mk()
	if err := xdr.SafeUnmarshal(raw, v); err != nil {
		if k == "valid" {
			return "fail"
		}
		return "pass"
	}
	if k != "valid" {
		return "fail"
	}
	m, ok := v.(marshaler)
	if !ok {
		return "fail"
	}
	again, err := m.MarshalBinary()
	if err != nil || !bytes.Equal(again, raw) {
		return "fail"
	}
	return "pass"
}

func main() {
	f, err := os.Open(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	gz, err := gzip.NewReader(f)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	kinds := map[string]*kind{}
	failing := map[string]map[string]int{}
	unsupported := map[string]bool{}
	fails := []failure{}
	n := 0
	sc := bufio.NewScanner(gz)
	sc.Buffer(make([]byte, 1<<20), 1<<26)
	for sc.Scan() {
		var c struct{ Type, Kind, B64 string }
		if err := json.Unmarshal(sc.Bytes(), &c); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		n++
		k := kinds[c.Kind]
		if k == nil {
			k = &kind{}
			kinds[c.Kind] = k
		}
		k.Cases++
		switch outcome(c.Type, c.Kind, c.B64) {
		case "unsupported":
			unsupported[c.Type] = true
		case "pass":
			k.Supported++
			k.Passed++
		default:
			k.Supported++
			if failing[c.Kind] == nil {
				failing[c.Kind] = map[string]int{}
			}
			failing[c.Kind][c.Type]++
			if len(fails) < 200 {
				b := c.B64
				if len(b) > 120 {
					b = b[:120]
				}
				fails = append(fails, failure{c.Type, c.Kind, b})
			}
		}
	}
	supported, passed := 0, 0
	for _, k := range kinds {
		supported += k.Supported
		passed += k.Passed
	}
	un := make([]string, 0, len(unsupported))
	for t := range unsupported {
		un = append(un, t)
	}
	sort.Strings(un)
	version := "unknown"
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			if d.Path == "github.com/stellar/go-stellar-sdk" {
				version = d.Version
			}
		}
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	_ = enc.Encode(map[string]any{
		"sdk": "go", "package": "github.com/stellar/go-stellar-sdk", "version": strings.TrimPrefix(version, "v"),
		"cases": n, "supported": supported, "passed": passed, "kinds": kinds,
		"failing_types": failing, "unsupported_types": un, "failures": fails,
	})
}
