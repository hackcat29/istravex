// Command goldens checks go-stellar-sdk against stellar-core's golden
// LedgerCloseMeta (test-lcm-current/, fetched by kit/goldens/fetch.mjs): every
// frame must decode and re-encode byte-for-byte.
//
//	go run ./cmd/goldens ../../.cache/stellar-core/test-lcm-current ../../corpus
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"

	"github.com/stellar/go-stellar-sdk/xdr"
)

type failure struct {
	File  string `json:"file"`
	Frame int    `json:"frame"`
	Error string `json:"error"`
}

func frames(b []byte) [][]byte {
	var out [][]byte
	for off := 0; off+4 <= len(b); {
		n := int(binary.BigEndian.Uint32(b[off:]) & 0x7fffffff)
		if off+4+n > len(b) {
			break
		}
		out = append(out, b[off+4:off+4+n])
		off += 4 + n
	}
	return out
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: goldens <test-lcm-current dir> <corpus dir>")
		os.Exit(2)
	}
	dir, corpus := os.Args[1], os.Args[2]
	files, _ := filepath.Glob(filepath.Join(dir, "*", "*.xdr"))
	sort.Strings(files)
	var nFrames, exact int
	failures := []failure{}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			panic(err)
		}
		rel, _ := filepath.Rel(dir, f)
		for i, fr := range frames(raw) {
			nFrames++
			var lcm xdr.LedgerCloseMeta
			if err := xdr.SafeUnmarshal(fr, &lcm); err != nil {
				failures = append(failures, failure{rel, i, err.Error()})
				continue
			}
			out, err := lcm.MarshalBinary()
			if err != nil || !bytes.Equal(out, fr) {
				failures = append(failures, failure{rel, i, "re-encode differs"})
				continue
			}
			exact++
		}
	}
	version := "unknown"
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			if d.Path == "github.com/stellar/go-stellar-sdk" {
				version = strings.TrimPrefix(d.Version, "v")
			}
		}
	}
	res := map[string]any{"sdk": "go", "package": "github.com/stellar/go-stellar-sdk", "version": version,
		"files": len(files), "frames": nFrames, "exact": exact, "failures": failures}
	b, _ := json.MarshalIndent(res, "", "  ")
	if err := os.WriteFile(filepath.Join(corpus, "results", "goldens-go.json"), append(b, '\n'), 0o644); err != nil {
		panic(err)
	}
	fmt.Printf("go: %d/%d frames exact in %d files, %d failures\n", exact, nFrames, len(files), len(failures))
	if len(failures) > 0 {
		os.Exit(1)
	}
}
