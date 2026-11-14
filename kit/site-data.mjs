// Fold the corpus and runner results into src/data/corpus.json for the site.
// The site renders only what this file contains, so every number on the page
// traces back to a fixture or a runner result.
//   node kit/site-data.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { xdr } from '@stellar/stellar-sdk';
import { ROOT, RESULTS, readCorpus } from './lib/fixture.mjs';

const read = (f) => JSON.parse(readFileSync(join(RESULTS, f), 'utf8'));
const json = (v) => JSON.parse(JSON.stringify(v));
const corpus = readCorpus();
const sdks = ['javascript', 'go', 'rust'].filter((s) => existsSync(join(RESULTS, `${s}.json`))).map((s) => read(`${s}.json`));
const js = sdks.find((s) => s.sdk === 'javascript');
const replay = read('replay.json').rows;
const provenance = read('provenance.json').fixtures;
const pilotRaw = read('pilot-wallet-backend.json');
const coverage = JSON.parse(readFileSync(join(ROOT, 'corpus', 'coverage.json'), 'utf8'));

// Source lines around each lint finding, from the pinned checkout the pilot used.
const wbDir = join(ROOT, '.cache', 'wallet-backend');
const lintFindings = pilotRaw.lint.findings.map((f) => {
  const path = join(wbDir, f.file);
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const from = Math.max(0, f.line - 5);
  return { ...f, snippet: { from: from + 1, lines: lines.slice(from, f.line + 3) } };
});

const fixtures = corpus.map(({ manifest: m, blobs }) => {
  const { files, ...rest } = m;
  return {
    id: m.id,
    cap: m.cap_ids[0],
    network: m.network,
    ledger: m.source.ledger,
    tx_hash: m.source.tx_hash,
    protocol_version: m.protocol_version,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    files: files.map((f) => ({ name: f.name, xdr_type: f.xdr_type, sha256: f.sha256, bytes: f.bytes })),
    manifest: rest,
    primary: { name: files[0].name, xdr_type: files[0].xdr_type, b64: blobs[files[0].name] },
    provenance: (() => {
      const p = provenance.find((x) => x.fixture === m.id);
      return p && { checks: p.checks.length, passed: p.checks.filter((c) => c.ok).length, ledger_source: p.ledger_source };
    })(),
  };
});

const checks = sdks.flatMap((s) => s.results.flatMap((r) => Object.values(r.checks)));
const provChecks = provenance.flatMap((p) => p.checks);
const stats = {
  provenance_checks: provChecks.length,
  provenance_passed: provChecks.filter((c) => c.ok).length,
  pilot_fixtures: pilotRaw.results.length,
  pilot_correct: pilotRaw.results.filter((r) => r.verdict === 'correct').length,
  live_caps: coverage.live_caps,
  xdr_caps: coverage.xdr_changing_caps,
  covered_xdr_caps: coverage.covered_xdr_caps,
  fixtures: fixtures.length,
  caps: new Set(fixtures.map((f) => f.cap)).size,
  networks: [...new Set(fixtures.map((f) => f.network))],
  bytes: fixtures.reduce((n, f) => n + f.bytes, 0),
  sdk_checks: checks.length,
  sdk_checks_passed: checks.filter((c) => c === 'pass').length,
  naive_faults: replay.filter((r) => r.indexer === 'naive' && r.verdict !== 'correct').length,
  reference_correct: replay.filter((r) => r.indexer === 'reference' && r.verdict === 'correct').length,
  replay_cases: replay.filter((r) => r.indexer === 'reference').length,
  max_protocol: Math.max(...fixtures.map((f) => f.protocol_version)),
};

// Real values for the anatomy tree (muxed payment fixture).
const muxed = corpus.find((c) => c.manifest.cap_ids[0] === 'CAP-0027');
const env = json(xdr.TransactionEnvelope.fromXDR(muxed.blobs.envelope, 'base64'));
const fb = env.tx_fee_bump?.tx;
const inner = fb ? fb.inner_tx.tx : env.tx;
const pay = inner.tx.operations[muxed.manifest.expected_decoded.op_index].body.payment;
const anatomyValues = {
  feeSource: fb?.fee_source,
  outerFee: fb && String(fb.fee),
  source: inner.tx.source_account,
  fee: String(inner.tx.fee),
  seqNum: String(inner.tx.seq_num),
  destination: pay.destination,
  id: muxed.manifest.expected_decoded.muxed_id,
  ed25519: muxed.manifest.expected_decoded.destination_account,
  asset: muxed.manifest.expected_decoded.asset,
  amount: String(pay.amount),
  signatures: String((fb ? env.tx_fee_bump.signatures : env.tx.signatures).length),
};

const out = {
  generated_by: 'kit/site-data.mjs',
  stats,
  fixtures,
  sdks: sdks.map(({ results, ...meta }) => ({ ...meta, results })),
  probes: js?.probes ?? [],
  replay,
  anatomy: { fixture: muxed.manifest.id, tx_hash: muxed.manifest.source.tx_hash, ledger: muxed.manifest.source.ledger, values: anatomyValues },
  coverage: {
    source: coverage.source,
    xdr_caps: coverage.caps.filter((c) => c.changes_xdr).map((c) => ({ cap: c.cap, title: c.title, protocol: c.protocol_version, covered: c.fixtures.length > 0 })),
  },
  pilot: {
    component: pilotRaw.component,
    repo: pilotRaw.repo,
    ref: pilotRaw.ref,
    entrypoint: pilotRaw.entrypoint,
    results: pilotRaw.results,
    lint: { rules: pilotRaw.lint.rules, findings: lintFindings },
  },
};
mkdirSync(join(ROOT, 'src', 'data'), { recursive: true });
writeFileSync(join(ROOT, 'src', 'data', 'corpus.json'), JSON.stringify(out, null, 2) + '\n');
console.log(stats);
