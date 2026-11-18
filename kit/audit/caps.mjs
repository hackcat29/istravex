// CAP coverage audit. Reads every Core Advancement Proposal from a pinned
// stellar-protocol checkout, keeps the ones live on the network (Final or
// Implemented), detects which change XDR (their spec diffs touch Stellar-*.x
// files), and maps the corpus onto them.
//
// Writes corpus/coverage.json and docs/corpus/cap-coverage.mdx (Mintlify page).
//   node kit/audit/caps.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ROOT, readCorpus } from '../lib/fixture.mjs';
import { corpusCells, universe } from '../lib/cells.mjs';
import { capOf } from './cell-caps.mjs';

export const REPO = 'https://github.com/stellar/stellar-protocol';
export const REF = 'ced008c3727005ca4a775f430fe6fe346c30f58f'; // master @ 2026-11-04
const DIR = join(ROOT, '.cache', 'stellar-protocol');
const LIVE = new Set(['Final', 'Implemented']);

function checkout() {
  const sh = (args) => execFileSync('git', args, { cwd: DIR, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (!existsSync(join(DIR, '.git'))) {
    mkdirSync(DIR, { recursive: true });
    sh(['init', '-q']);
    sh(['remote', 'add', 'origin', REPO]);
  }
  const head = existsSync(join(DIR, 'core')) ? sh(['rev-parse', 'HEAD']).trim() : '';
  if (head !== REF) {
    sh(['fetch', '-q', '--depth', '1', 'origin', REF]);
    sh(['checkout', '-q', '--force', REF]);
  }
}

export function parseCap(text) {
  const field = (k) => text.match(new RegExp(`^${k}:\\s*(.+)$`, 'mi'))?.[1].trim();
  const status = field('Status')?.split(/[\s(]/)[0];
  const pv = field('Protocol version');
  const xdrFiles = [...new Set(text.match(/Stellar-[A-Za-z-]+\.x/g) ?? [])].sort();
  // Inline XDR definitions (older CAPs spell out the new types instead of diffing .x files).
  const xdrDefs = /^\s*(union\s+\w+\s+switch\s*\(|struct\s+\w+\s*$|struct\s+\w+\s*\{|enum\s+\w+\s*$|enum\s+\w+\s*\{|typedef\s+\w+)/m.test(text);
  const [num, sub] = ((field('CAP') ?? '').match(/\d{4}(-\d{2})?/)?.[0] ?? '').split('-');
  return {
    cap: `CAP-${num.padStart(4, '0')}${sub ? `-${sub}` : ''}`,
    title: field('Title') ?? '',
    status,
    protocol_version: pv && /^\d+$/.test(pv) ? Number(pv) : null,
    xdr_files: xdrFiles,
    xdr_defs: xdrDefs,
  };
}

// Why a live CAP has no fixture: it leaves no shape a ledger reader meets.
const NO_LEDGER_SHAPE = {
  'CAP-0002': 'Changes how signatures are checked, not what a ledger records.',
  'CAP-0004': 'Changes offer-crossing arithmetic; amounts land in fields every trade already uses.',
  'CAP-0005': 'Changes fee pricing (surge pricing); fees land in fields every transaction already has.',
  'CAP-0020': 'Adds INITENTRY to buckets in history archives, which a LedgerCloseMeta never carries.',
  'CAP-0025': 'Changes how buckets merge; nothing in a ledger changes.',
  'CAP-0026': 'Disables inflation; the Inflation operation already exists and now only fails.',
  'CAP-0028': 'Removes a pre-authorized signer when its transaction fails: a ledger entry change of an existing kind.',
  'CAP-0029': 'Lets AllowTrust run without AUTH_REQUIRED; same operation and result shapes.',
  'CAP-0030': 'Removes result codes; nothing new to read.',
  'CAP-0034': 'Changes nomination in consensus; nothing in a ledger changes.',
  'CAP-0046-03': 'Host functions run inside contract execution; their inputs and outputs are ScVals the corpus already covers.',
  'CAP-0051': 'secp256r1 verification is a host function; its cost types are covered by the protocol-upgrade ledgers.',
  'CAP-0053': 'Host functions for TTL extension; their effects are TTL entry changes of an existing kind.',
  'CAP-0055': 'Wasm linking inside the VM; no ledger shape.',
  'CAP-0056': 'Module caching inside a transaction; no ledger shape.',
  'CAP-0065': 'Module cache reuse across ledgers; no ledger shape.',
  'CAP-0068': 'A host function returning an address executable; no new value in ledger data.',
  'CAP-0069': 'String and bytes conversion host functions; no ledger shape.',
  'CAP-0075': 'Poseidon host functions; pinned XDR has no cost type for them, so no ledger shape.',
  'CAP-0076': 'A one-time state repair at the protocol 24 upgrade, made of ledger entry changes of existing kinds.',
  'CAP-0078': 'Host functions for limited TTL extension; their effects are TTL changes of an existing kind.',
  'CAP-0079': 'Host functions for muxed strkey conversion; no ledger shape.',
  'CAP-0082': 'Checked 256-bit arithmetic host functions; no ledger shape.',
  'CAP-0086': 'Host functions for Symbol-keyed maps; values are ScMaps the corpus already covers.',
};
// Has a ledger shape, but none was captured yet, and why.
const OPEN_GAPS = {
  'CAP-0070': 'CONFIG_SETTING_SCP_TIMING was created at the protocol 23 upgrade, before the history Horizon keeps (expected values come from Horizon). The data lake holds that ledger.',
  'CAP-0083': 'STELLAR_VALUE_EMPTY_TX_SET appears only when validators vote to drop a transaction set; no scanned ledger has one.',
  'CAP-0084': 'SC_ADDRESS_TYPE_MUXED_CONTRACT is new in protocol 30, and no scanned testnet ledger uses it yet; the generator on a protocol 30 stellar-core can produce one.',
};

checkout();
const corpus = readCorpus();
const fixturesByCap = {};
for (const { manifest } of corpus) {
  for (const c of manifest.cap_ids) (fixturesByCap[c] ??= []).push(manifest.id);
}
// Cells: what every fixture exercises, what the networks show, what exists.
const { reachable } = universe();
const fixtureCells = corpusCells();
const inCorpus = new Map();
for (const f of fixtureCells) for (const c of f.cells) (inCorpus.get(c) ?? inCorpus.set(c, []).get(c)).push(f.fixture);
const seenOnNetworks = new Map();
const scanDir = join(ROOT, 'corpus', 'scan');
const scanned = { ledgers: 0, transactions: 0 };
for (const f of readdirSync(scanDir).filter((f) => f.endsWith('.jsonl.gz')).sort()) {
  for (const line of gunzipSync(readFileSync(join(scanDir, f))).toString().split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.kind !== 'summary') continue;
    scanned.ledgers += r.ledgers;
    scanned.transactions += r.transactions;
    for (const [c, n] of Object.entries(r.cell_counts)) seenOnNetworks.set(c, (seenOnNetworks.get(c) ?? 0) + n);
  }
}
const cellsByCap = {};
for (const c of reachable) (cellsByCap[capOf(c).cap] ??= []).push(c);
const parentOf = (cap) => cap.replace(/-\d{2}$/, '');

const caps = readdirSync(join(DIR, 'core'))
  .filter((f) => /^cap-\d{4}(-\d{2})?\.md$/.test(f))
  .map((f) => parseCap(readFileSync(join(DIR, 'core', f), 'utf8')))
  .filter((c) => LIVE.has(c.status))
  .map(({ xdr_defs, ...c }) => {
    // A CAP's cells are its own, plus its parts' for an umbrella CAP (CAP-0046, CAP-0071).
    const cells = Object.entries(cellsByCap)
      .filter(([cap]) => cap === c.cap || (c.cap.length === 8 && parentOf(cap) === c.cap && cap !== c.cap))
      .flatMap(([, v]) => v);
    const corpusHits = cells.filter((x) => inCorpus.has(x));
    const exercised = [...new Set(corpusHits.flatMap((x) => inCorpus.get(x)))].sort();
    const tagged = fixturesByCap[c.cap] ?? [];
    const fixtures = [...new Set([...tagged, ...exercised])].sort();
    return {
      ...c,
      changes_xdr: c.xdr_files.length > 0 || xdr_defs,
      cells: cells.length,
      cells_seen_on_networks: cells.filter((x) => seenOnNetworks.has(x)).length,
      cells_in_corpus: corpusHits.length,
      fixtures,
      ...(!fixtures.length && { gap: OPEN_GAPS[c.cap] ? 'open' : NO_LEDGER_SHAPE[c.cap] ? 'no-ledger-shape' : 'unexplained', reason: OPEN_GAPS[c.cap] ?? NO_LEDGER_SHAPE[c.cap] ?? null }),
    };
  })
  .sort((a, b) => a.cap.localeCompare(b.cap));

const xdrCaps = caps.filter((c) => c.changes_xdr);
const withShape = caps.filter((c) => c.fixtures.length || c.gap === 'open');
const reachableSeen = reachable.filter((c) => seenOnNetworks.has(c));
const summary = {
  source: { repo: REPO, ref: REF },
  live_caps: caps.length,
  xdr_changing_caps: xdrCaps.length,
  covered_caps: caps.filter((c) => c.fixtures.length).length,
  covered_xdr_caps: xdrCaps.filter((c) => c.fixtures.length).length,
  caps_with_ledger_shape: withShape.length,
  caps_without_ledger_shape: caps.filter((c) => c.gap === 'no-ledger-shape').length,
  open_gaps: caps.filter((c) => c.gap === 'open').map((c) => c.cap),
  unexplained: caps.filter((c) => c.gap === 'unexplained').map((c) => c.cap),
  cells: {
    reachable: reachable.length,
    seen_on_networks: reachableSeen.length,
    in_corpus: reachable.filter((c) => inCorpus.has(c)).length,
    seen_and_in_corpus: reachableSeen.filter((c) => inCorpus.has(c)).length,
  },
  scanned,
};
writeFileSync(join(ROOT, 'corpus', 'coverage.json'), JSON.stringify({ ...summary, caps }, null, 2) + '\n');
writeFileSync(
  join(ROOT, 'corpus', 'cells.json'),
  JSON.stringify(
    {
      note: 'Every XDR cell (union arm, or interpreted flag bit) a ledger reader can meet: reachable from LedgerCloseMeta in the pinned go-stellar-sdk XDR. seen = occurrences in the shape scans (corpus/scan); fixtures = corpus fixtures that exercise it. Generated by kit/audit/caps.mjs.',
      ...summary.cells,
      cells: reachable.map((c) => ({ cell: c, cap: capOf(c).cap, seen: seenOnNetworks.get(c) ?? 0, fixtures: inCorpus.get(c) ?? [] })),
    },
    null,
    1,
  ) + '\n',
);

// MDX-safe table cell: escape pipes, braces and angle brackets.
const cell = (s) => s.replace(/\|/g, '\\|').replace(/[{}<>]/g, (ch) => `&#${ch.charCodeAt(0)};`);
const fixtureList = (c) => {
  if (!c.fixtures.length) return c.gap === 'open' ? `**gap**: ${cell(c.reason)}` : `no ledger shape: ${cell(c.reason ?? 'unexplained')}`;
  const shown = c.fixtures.slice(0, 3).map((f) => `\`${f}\``).join('<br />');
  return c.fixtures.length > 3 ? `${shown}<br />and ${c.fixtures.length - 3} more` : shown;
};
const row = (c) =>
  `| [${c.cap}](${REPO}/blob/${REF}/core/${c.cap.toLowerCase()}.md) | ${cell(c.title)} | ${c.protocol_version ?? '—'} | ${c.cells ? `${c.cells_in_corpus}/${c.cells}` : '—'} | ${fixtureList(c)} |`;
const md = `---
title: CAP coverage
description: Every live Core Advancement Proposal, the XDR cells it introduced, and which fixtures cover it.
---

{/* Generated by kit/audit/caps.mjs. Do not edit by hand: run npm run corpus:audit. */}

Audited from [stellar-protocol@${REF.slice(0, 7)}](${REPO}/tree/${REF}/core).

- **${summary.live_caps}** CAPs are live (status Final or Implemented); **${summary.xdr_changing_caps}** of them change XDR.
- **${summary.covered_caps}** have fixtures. A CAP is covered when a fixture exercises an XDR cell it introduced (a union arm, a flag bit, or a contract cost type), or the fixture is tagged with it.
- **${summary.caps_without_ledger_shape}** leave no shape a ledger reader meets (host functions, consensus, buckets); each row says why.
- **${summary.open_gaps.length}** have a ledger shape the corpus lacks: ${summary.open_gaps.join(', ')}.

Cells are counted by [\`kit/go/cmd/shape-scan\`](https://github.com/hackcat29/istravex/tree/main/kit/go/cmd/shape-scan): **${summary.cells.reachable}** cells are reachable from \`LedgerCloseMeta\`; **${summary.cells.seen_on_networks}** occur in ${summary.scanned.ledgers.toLocaleString('en-US')} scanned mainnet and testnet ledgers (${summary.scanned.transactions.toLocaleString('en-US')} transactions); the corpus covers **${summary.cells.seen_and_in_corpus}** of those. Which CAP introduced each cell is set in [\`kit/audit/cell-caps.mjs\`](https://github.com/hackcat29/istravex/blob/main/kit/audit/cell-caps.mjs); the full list is [\`corpus/cells.json\`](https://github.com/hackcat29/istravex/blob/main/corpus/cells.json).

## XDR-changing CAPs

| CAP | Title | Protocol | Cells in corpus | Fixtures |
|---|---|---|---|---|
${xdrCaps.map(row).join('\n')}

## Other live CAPs

| CAP | Title | Protocol | Cells in corpus | Fixtures |
|---|---|---|---|---|
${caps.filter((c) => !c.changes_xdr).map(row).join('\n')}
`;
writeFileSync(join(ROOT, 'docs', 'corpus', 'cap-coverage.mdx'), md);
const { caps_with_ledger_shape, covered_caps, open_gaps, unexplained, cells } = summary;
console.log({ live: summary.live_caps, covered_caps, caps_with_ledger_shape, open_gaps, unexplained, cells });
