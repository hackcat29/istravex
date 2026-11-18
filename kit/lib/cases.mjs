// Summaries for generated-case results, shared by the runners written in JS
// (the Go, Python, Java and PHP runners write the same shape).
//
// Each result is { type, kind, outcome } with outcome pass | fail | unsupported.

/** Counts per kind, the failing (kind, type) pairs, and unsupported types. */
export function summarize(results) {
  const kinds = {};
  const failing = {};
  const unsupported = new Set();
  for (const r of results) {
    const k = (kinds[r.kind] ??= { cases: 0, supported: 0, passed: 0 });
    k.cases++;
    if (r.outcome === 'unsupported') {
      unsupported.add(r.type);
      continue;
    }
    k.supported++;
    if (r.outcome === 'pass') k.passed++;
    else (failing[r.kind] ??= {})[r.type] = (failing[r.kind]?.[r.type] ?? 0) + 1;
  }
  const sum = (f) => Object.values(kinds).reduce((n, k) => n + k[f], 0);
  const failures = results.filter((r) => r.outcome === 'fail').slice(0, 200).map(({ type, kind, b64 }) => ({ type, kind, b64: b64.slice(0, 120) }));
  return {
    cases: results.length,
    supported: sum('supported'),
    passed: sum('passed'),
    kinds,
    failing_types: Object.fromEntries(Object.entries(failing).map(([k, t]) => [k, Object.fromEntries(Object.entries(t).sort())])),
    unsupported_types: [...unsupported].sort(),
    failures,
  };
}
