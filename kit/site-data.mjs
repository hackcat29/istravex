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
const goldens = ['javascript', 'go', 'rust'].map((s) => read(`goldens-${s}.json`));
const goldenPatterns = read('goldens-patterns.json');

const lintFindings = pilotRaw.lint.findings; // each carries its source snippet

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
  golden_files: goldens[0].files,
  golden_frames: goldens[0].frames,
  golden_exact: Math.min(...goldens.map((g) => g.exact)),
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
  // runtime is omitted: it varies by machine and the site does not show it.
  sdks: sdks.map(({ results, runtime, ...meta }) => ({ ...meta, results })),
  probes: js?.probes ?? [],
  replay,
  anatomy: { fixture: muxed.manifest.id, tx_hash: muxed.manifest.source.tx_hash, ledger: muxed.manifest.source.ledger, values: anatomyValues },
  coverage: {
    source: coverage.source,
    xdr_caps: coverage.caps.filter((c) => c.changes_xdr).map((c) => ({ cap: c.cap, title: c.title, protocol: c.protocol_version, covered: c.fixtures.length > 0 })),
  },
  goldens: {
    core_commit: goldenPatterns.core_commit,
    sdks: goldens.map(({ sdk, package: pkg, version, files, frames, exact }) => ({ sdk, package: pkg, version, files, frames, exact })),
    patterns: Object.fromEntries(Object.entries(goldenPatterns.caps).map(([cap, c]) => [cap, { pattern: c.pattern, golden_files: c.golden_files }])),
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

// ── Docs (Mintlify): generated tables as snippets, and the API spec ─────────
// Pages import these (`import Numbers from '/snippets/numbers.mdx'`), so the
// docs show the same numbers as the site and can never drift from the corpus.
const DOCS = join(ROOT, 'docs');
const gen = '{/* Generated by kit/site-data.mjs from corpus/. Do not edit: run npm run corpus:data. */}\n\n';
const snippet = (name, body) => writeFileSync(join(DOCS, 'snippets', `${name}.mdx`), gen + body.trim() + '\n');
const code = (s) => `\`${s}\``;
const short = (s) => (s.length > 16 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);
const explorer = (f) =>
  f.network === 'local' ? 'generated' : `[${short(f.tx_hash)}](https://stellar.expert/explorer/${f.network === 'pubnet' ? 'public' : 'testnet'}/tx/${f.tx_hash})`;

mkdirSync(join(DOCS, 'snippets'), { recursive: true });
snippet(
  'numbers',
  `| What | Result |
|---|---|
| Fixtures | **${stats.fixtures}** across ${stats.caps} CAPs (${stats.networks.join(', ')}) |
| Provenance | **${stats.provenance_passed}/${stats.provenance_checks}** checks, byte-identical to canonical ledgers |
| SDK conformance | **${stats.sdk_checks_passed}/${stats.sdk_checks}** checks across JavaScript, Go and Rust |
| stellar-core goldens | **${stats.golden_exact.toLocaleString('en-US')}/${stats.golden_frames.toLocaleString('en-US')}** LedgerCloseMeta frames round-trip in every SDK |
| Replay | naive indexer wrong on **${stats.naive_faults}/${stats.replay_cases}**; reference indexer right on **${stats.reference_correct}/${stats.replay_cases}** |
| wallet-backend pilot | **${stats.pilot_correct}/${stats.pilot_fixtures}** fixtures indexed correctly |
| CAP coverage | ${stats.covered_xdr_caps} of ${stats.xdr_caps} XDR-changing CAPs (${stats.live_caps} live) |`,
);
snippet(
  'fixtures-table',
  `| Fixture | CAP | Network | Ledger | Protocol | Transaction |
|---|---|---|---|---|---|
${fixtures.map((f) => `| ${code(f.id)} | ${f.cap} | ${f.network} | ${f.ledger.toLocaleString('en-US')} | ${f.protocol_version} | ${explorer(f)} |`).join('\n')}`,
);
snippet(
  'sdk-table',
  `| SDK | Version | Fixtures (decode · re-encode · native) | stellar-core goldens |
|---|---|---|---|
${sdks
  .map((s) => {
    const n = s.results.length;
    const pass = (k) => s.results.filter((r) => r.checks[k] === 'pass').length;
    const g = goldens.find((x) => x.sdk === s.sdk);
    return `| ${code(s.package)} | ${s.version} | ${pass('decode')}/${n} · ${pass('reencode')}/${n} · ${pass('native')}/${n} | ${g ? `${g.exact.toLocaleString('en-US')}/${g.frames.toLocaleString('en-US')} frames` : '—'} |`;
  })
  .join('\n')}`,
);
snippet(
  'replay-table',
  `| Fixture | Indexer | Verdict | Fields that differ |
|---|---|---|---|
${replay.map((r) => `| ${code(r.fixture)} | ${r.indexer} | ${r.verdict} | ${r.diffs.length ? r.diffs.map(code).join(', ') : '—'} |`).join('\n')}`,
);
snippet(
  'pilot-table',
  `| Fixture | Verdict | Checks |
|---|---|---|
${pilotRaw.results.map((r) => `| ${code(r.fixture)} | ${r.verdict} | ${r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.field}`).join('<br />')} |`).join('\n')}`,
);
mkdirSync(join(DOCS, 'api-reference'), { recursive: true });
// The docs copy of the spec carries real response examples, produced by the
// API itself over the current corpus, so the reference never shows made-up data.
const { createApp } = await import('../server/app.ts');
const api = createApp({ corpusDir: join(ROOT, 'corpus'), version: 'docs' });
const spec = JSON.parse(readFileSync(join(ROOT, 'server', 'openapi.json'), 'utf8'));
const truncate = (v) => (typeof v === 'string' && v.length > 160 ? `${v.slice(0, 157)}…` : v);
const sample = async (url, init) => JSON.parse(JSON.stringify(await (await api.request(url, init)).json(), (_, v) => truncate(v)));
const examples = {
  '/v1/stats': await sample('/v1/stats'),
  '/v1/fixtures': await sample('/v1/fixtures'),
  '/v1/fixtures/{id}': await sample('/v1/fixtures/cap27-muxed-payment-pubnet-0001'),
  '/v1/ledgers': await sample('/v1/ledgers'),
  '/v1/results': await sample('/v1/results'),
};
for (const [path, example] of Object.entries(examples)) {
  spec.paths[path].get.responses['200'].content['application/json'].example = example;
}
const rpcReq = { jsonrpc: '2.0', id: 1, method: 'getHealth' };
spec.paths['/rpc/{network}'].post.responses['200'].content['application/json'].example = await sample('/rpc/pubnet', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(rpcReq),
});
writeFileSync(join(DOCS, 'api-reference', 'openapi.json'), JSON.stringify(spec, null, 2) + '\n');
