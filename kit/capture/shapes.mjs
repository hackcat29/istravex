// Turn shape-scan output into corpus fixtures, choosing by set cover.
//
// corpus/scan/*.jsonl.gz is kit/go/cmd/shape-scan's output over real ledgers
// (.github/workflows/shape-scan.yml, plus the protocol-upgrade ledgers). Each
// record lists the XDR cells one transaction or one ledger exercises. This
// script picks, greedily, the records that add the most cells not yet in the
// corpus, preferring ledgers it already holds, until every cell seen on the
// networks is covered. Each pick becomes a fixture:
//
//   profile "tx":     envelope, result, meta and fee meta from the canonical
//                     ledger; expected values from Horizon's JSON.
//   profile "ledger": the whole LedgerCloseMeta; expected values from
//                     Horizon's ledger record.
//
// Expected values never come from an SDK under test. The canonical ledger is
// stored byte for byte from SDF's public data lake.
//
//   node kit/capture/shapes.mjs [--dry-run]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { xdr } from '@stellar/stellar-sdk';
import { capOf } from '../audit/cell-caps.mjs';
import { CORPUS, readCorpus, writeFixture } from '../lib/fixture.mjs';
import { fetchLakeLedger, ledgerStored, readLedger, storeLedger, txFromLedger } from '../lib/ledger.mjs';
import { corpusCells } from '../lib/cells.mjs';

const dryRun = process.argv.includes('--dry-run');
const HORIZON = { pubnet: 'https://horizon.stellar.org', testnet: 'https://horizon-testnet.stellar.org' };

async function horizon(network, path) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(HORIZON[network] + path);
    if (r.ok) return r.json();
    if (attempt === 4 || r.status === 404) throw new Error(`${r.status} ${network} ${path}`);
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
}

// ── Load the scans ────────────────────────────────────────────────────────
const scanDir = join(CORPUS, 'scan');
const records = [];
for (const f of readdirSync(scanDir).filter((f) => f.endsWith('.jsonl.gz')).sort()) {
  for (const line of gunzipSync(readFileSync(join(scanDir, f))).toString().split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.kind === 'tx' || r.kind === 'ledger') records.push(r);
  }
}
// Expected values come from Horizon, which keeps pubnet history from ledger
// 59,227,201 and testnet's from ledger 128.
const usable = records.filter((r) => (r.network === 'pubnet' ? r.ledger >= 59227201 : r.ledger >= 128));
const seen = new Set(usable.flatMap((r) => r.cells));

// ── Greedy set cover, deterministic ───────────────────────────────────────
const have = new Set(corpusCells().flatMap((f) => f.cells));
const held = new Set(readCorpus().map(({ manifest: m }) => `${m.network}/${m.source.ledger}`));
const key = (r) => `${r.network}/${r.ledger}/${r.tx_hash ?? 'ledger'}`;
usable.sort((a, b) => key(a).localeCompare(key(b)));
const picks = [];
for (;;) {
  let best = null;
  let bestScore = 0;
  for (const r of usable) {
    const add = r.cells.filter((c) => !have.has(c));
    if (!add.length) continue;
    // A new ledger costs storage; whole pubnet ledgers as fixtures cost more.
    let cost = held.has(`${r.network}/${r.ledger}`) ? 1 : 2.5;
    if (r.kind === 'ledger') cost *= r.network === 'pubnet' ? 6 : 1.5;
    const score = add.length / cost;
    if (score > bestScore) [best, bestScore] = [r, score];
  }
  if (!best) break;
  const adds = best.cells.filter((c) => !have.has(c));
  adds.forEach((c) => have.add(c));
  held.add(`${best.network}/${best.ledger}`);
  picks.push({ ...best, adds });
}
console.log(`${seen.size} cells seen on the networks; ${picks.length} picks to cover the ${picks.reduce((n, p) => n + p.adds.length, 0)} the corpus lacks`);
if (dryRun) {
  for (const p of picks) console.log(p.kind.padEnd(6), `${p.network}/${p.ledger}`, (p.tx_hash ?? '').slice(0, 12), p.adds.length, p.adds.slice(0, 3).join(' '));
  process.exit(0);
}

// ── Naming ────────────────────────────────────────────────────────────────
const capRank = (cap) => (cap === 'base' ? -1 : Number(cap.slice(4, 8)) * 100 + Number(cap.slice(9) || 0));
/** The cell a pick is named after: the one from the newest CAP, then the most specific. */
function lead(cells) {
  return [...cells].sort((a, b) => capRank(capOf(b).cap) - capRank(capOf(a).cap) || a.localeCompare(b))[0];
}
const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
function slug(cell) {
  const [type, arm] = cell.split(':');
  const t = kebab(type.replace('.flags', '-flags'));
  let a = kebab(arm)
    .replace(/^(sc-address-type|host-function-type|soroban-credentials|soroban-authorized-function-type|claim-predicate|ledger-upgrade|config-setting|envelope-type|precond|stellar-value|contract-executable|contract-id-preimage|signer-key-type|asset-type|key-type|public-key-type|txset-comp|claim-atom-type|liquidity-pool|revoke-sponsorship|memo|scv|sce|ledger-entry)-/, '');
  // Result codes carry their operation's name already.
  if (/result$/.test(t)) return a.slice(0, 48);
  return `${t}-${a}`.slice(0, 48).replace(/-$/, '');
}
const used = new Set(readCorpus().map(({ manifest: m }) => m.id));
function idFor(pick) {
  const cell = lead(pick.adds);
  const { cap } = capOf(cell);
  const capPart = cap === 'base' ? 'base' : `cap${Number(cap.slice(4, 8))}`;
  for (let n = 1; ; n++) {
    const id = `${capPart}-${slug(cell)}-${pick.network}-${String(n).padStart(4, '0')}`;
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
}
const capsOf = (cells) => {
  const caps = [...new Set(cells.map((c) => capOf(c).cap).filter((c) => c !== 'base'))];
  return caps.sort((a, b) => capRank(b) - capRank(a));
};

// ── Capture ───────────────────────────────────────────────────────────────
async function ensureLedger(network, seq) {
  if (ledgerStored(network, seq)) return;
  const got = await fetchLakeLedger(network, seq);
  storeLedger(network, seq, got.raw, got.source, got.zst);
}

let written = 0;
for (const pick of picks) {
  await ensureLedger(pick.network, pick.ledger);
  const lcm = readLedger(pick.network, pick.ledger);
  const id = idFor(pick);
  const base = {
    id,
    cap_ids: capsOf(pick.adds),
    network: pick.network,
    covers: pick.adds,
    synthetic: false,
  };
  if (pick.kind === 'tx') {
    const tx = await horizon(pick.network, `/transactions/${pick.tx_hash}`);
    const ops = (await horizon(pick.network, `/transactions/${pick.tx_hash}/operations?limit=200`))._embedded.records;
    const canon = txFromLedger(lcm, pick.tx_hash);
    const feeBump = Boolean(tx.fee_bump_transaction);
    writeFixture({
      ...base,
      pattern: 'tx',
      protocol_version: pick.protocol,
      xdr_path: `cells: ${pick.adds.slice(0, 4).join(', ')}${pick.adds.length > 4 ? ', …' : ''}`,
      source: {
        kind: 'captured',
        network_endpoint: HORIZON[pick.network],
        ledger: tx.ledger,
        tx_hash: tx.hash,
        closed_at: tx.created_at,
        description: 'Chosen by set cover over shape-scan output (kit/capture/shapes.mjs); bytes from the canonical ledger, expected values from Horizon.',
      },
      expected_decoded: {
        profile: 'tx',
        tx_hash: tx.hash,
        successful: tx.successful,
        source_account: tx.source_account,
        ...(feeBump && { fee_account: tx.fee_account }),
        fee_charged: String(tx.fee_charged),
        max_fee: String(tx.max_fee),
        operation_count: tx.operation_count,
        operation_types: ops.map((o) => o.type).join(','),
        memo_type: tx.memo_type,
        signature_count: tx.signatures.length,
      },
      files: {
        envelope: { xdr_type: 'TransactionEnvelope', b64: tx.envelope_xdr },
        result: { xdr_type: 'TransactionResult', b64: canon.result },
        meta: { xdr_type: 'TransactionMeta', b64: canon.meta },
        fee_meta: { xdr_type: 'LedgerEntryChanges', b64: canon.fee_meta },
      },
    });
  } else {
    const h = await horizon(pick.network, `/ledgers/${pick.ledger}`);
    writeFixture({
      ...base,
      pattern: 'ledger',
      protocol_version: pick.protocol,
      xdr_path: `cells: ${pick.adds.slice(0, 4).join(', ')}${pick.adds.length > 4 ? ', …' : ''}`,
      source: {
        kind: 'captured',
        network_endpoint: HORIZON[pick.network],
        ledger: pick.ledger,
        closed_at: h.closed_at,
        description: 'A whole ledger chosen by set cover over shape-scan output (kit/capture/shapes.mjs); bytes from the canonical ledger, expected values from Horizon.',
      },
      expected_decoded: {
        profile: 'ledger',
        ledger_hash: h.hash,
        prev_hash: h.prev_hash,
        sequence: h.sequence,
        protocol_version: h.protocol_version,
        base_fee: String(h.base_fee_in_stroops),
        base_reserve: String(h.base_reserve_in_stroops),
        max_tx_set_size: h.max_tx_set_size,
        transaction_count: h.successful_transaction_count + h.failed_transaction_count,
        closed_at: h.closed_at,
      },
      files: {
        ledger: { xdr_type: 'LedgerCloseMeta', b64: lcm.toXDR('base64') },
      },
    });
  }
  written++;
}
console.log(`wrote ${written} fixtures`);
