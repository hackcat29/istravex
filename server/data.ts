// Loads the corpus, its canonical-ledger index and the kit's results once at
// startup. Everything served by the API is read from the repository's corpus/
// directory, the same files CI verifies.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Manifest = {
  id: string;
  pattern: string;
  cap_ids: string[];
  protocol_version: number;
  network: string;
  xdr_type: string;
  xdr_path: string;
  sha256: string;
  source: { kind: string; ledger?: number; tx_hash?: string; closed_at?: string; [k: string]: unknown };
  synthetic: boolean;
  expected_decoded?: Record<string, unknown>;
  expected_indexed?: Record<string, unknown>;
  files: { name: string; xdr_type: string; path: string; sha256: string; bytes: number; expect?: string }[];
};

export type LedgerEntry = { network: string; ledger: number; path: string; sha256: string; bytes: number; compressed_bytes: number; source: string };

export type Corpus = {
  dir: string;
  fixtures: Map<string, { manifest: Manifest; blobs: Map<string, string> }>;
  ledgers: LedgerEntry[];
  results: Map<string, unknown>;
  coverage: unknown;
  findings: unknown;
  stats: Record<string, unknown>;
};

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

export function loadCorpus(dir: string): Corpus {
  const fixtures = new Map<string, { manifest: Manifest; blobs: Map<string, string> }>();
  for (const d of readdirSync(join(dir, 'fixtures'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const manifest = json(join(dir, 'fixtures', d, 'manifest.json')) as Manifest;
    const blobs = new Map(manifest.files.map((f) => [f.name, readFileSync(join(dir, 'fixtures', d, f.path), 'utf8').trim()]));
    fixtures.set(manifest.id, { manifest, blobs });
  }
  const results = new Map<string, unknown>();
  for (const f of readdirSync(join(dir, 'results')).filter((n) => n.endsWith('.json')).sort()) {
    results.set(f.replace(/\.json$/, ''), json(join(dir, 'results', f)));
  }
  const ledgers = json(join(dir, 'ledgers', 'index.json')) as LedgerEntry[];
  const coverage = existsSync(join(dir, 'coverage.json')) ? json(join(dir, 'coverage.json')) : null;
  const findings = existsSync(join(dir, 'findings.json')) ? json(join(dir, 'findings.json')) : null;
  return { dir, fixtures, ledgers, results, coverage, findings, stats: summarize(fixtures, results, coverage) };
}

function summarize(fixtures: Corpus['fixtures'], results: Map<string, unknown>, coverage: unknown): Record<string, unknown> {
  type Checked = { results: { checks: Record<string, string> }[] };
  // 'n/a' marks checks that don't apply (re-encoding bytes a decoder must reject).
  const sdk = ['javascript', 'go', 'rust']
    .flatMap((s) => ((results.get(s) as Checked | undefined)?.results ?? []).flatMap((r) => Object.values(r.checks)))
    .filter((c) => c !== 'n/a');
  const prov = ((results.get('provenance') as { fixtures: { checks: { ok: boolean }[] }[] } | undefined)?.fixtures ?? []).flatMap((p) => p.checks);
  const goldens = ['javascript', 'go', 'rust'].map((s) => results.get(`goldens-${s}`) as { frames: number; exact: number } | undefined).filter(Boolean) as { frames: number; exact: number }[];
  const pilot = (results.get('pilot-wallet-backend') as { results: { verdict: string }[] } | undefined)?.results ?? [];
  const cov = coverage as { live_caps: number; xdr_changing_caps: number; covered_xdr_caps: number } | null;
  return {
    fixtures: fixtures.size,
    caps: new Set([...fixtures.values()].flatMap((f) => f.manifest.cap_ids)).size,
    networks: [...new Set([...fixtures.values()].map((f) => f.manifest.network))].sort(),
    sdk_checks: { passed: sdk.filter((c) => c === 'pass').length, total: sdk.length },
    provenance_checks: { passed: prov.filter((c) => c.ok).length, total: prov.length },
    golden_frames: goldens.length ? { exact: Math.min(...goldens.map((g) => g.exact)), total: goldens[0].frames } : null,
    wallet_backend_pilot: { correct: pilot.filter((r) => r.verdict === 'correct').length, total: pilot.length },
    cap_coverage: cov && { live: cov.live_caps, xdr_changing: cov.xdr_changing_caps, xdr_covered: cov.covered_xdr_caps },
  };
}
