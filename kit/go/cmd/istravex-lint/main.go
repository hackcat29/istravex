// Command istravex-lint runs the Istravex ingestion analyzers (IX001–IX003).
//
//	go run github.com/hackcat29/istravex/kit/go/cmd/istravex-lint ./...
//	istravex-lint -json ./... > findings.json
package main

import (
	"github.com/hackcat29/istravex/kit/go/lint"
	"golang.org/x/tools/go/analysis/multichecker"
)

func main() { multichecker.Main(lint.Analyzers...) }
