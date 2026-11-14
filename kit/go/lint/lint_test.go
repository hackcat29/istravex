package lint_test

import (
	"strings"
	"testing"

	"github.com/hackcat29/istravex/kit/go/lint"
	"golang.org/x/tools/go/analysis/analysistest"
)

// Each rule has a testdata package of the same name with positive cases
// (`// want`), guarded cases and suppressed cases.
func TestAnalyzers(t *testing.T) {
	for _, a := range lint.Analyzers {
		t.Run(a.Name, func(t *testing.T) {
			analysistest.Run(t, analysistest.TestData(), a, strings.ToLower(a.Name))
		})
	}
}
