// Sweep @stellar/stellar-sdk over whole ledgers of real traffic.
//
// For every LedgerCloseMetaBatch file given (raw XDR): the batch decodes and
// re-encodes byte for byte, and the hash the SDK computes for every
// transaction in the transaction set equals the hash stellar-core recorded
// for it in the ledger's results. Both oracles are stellar-core's own bytes.
//
//   node kit/runners/js/sweep.mjs --passphrase "…" ledger1.xdr … > sweep-javascript.json
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { loadSdk } from './run.mjs';
import { ROOT } from '../../lib/fixture.mjs';

const { values: opt, positionals: files } = parseArgs({ options: { passphrase: { type: 'string', default: 'Public Global Stellar Network ; September 2015' } }, allowPositionals: true });
const { sdk, version } = await loadSdk(ROOT);
const { TransactionBuilder, xdr } = sdk;

const hex = (h) => Buffer.from(h?.value ?? h).toString('hex');
/** Every TransactionEnvelope in a transaction set, whatever its shape. */
function envelopes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.type === 'string' && node.type.startsWith('envelopeType')) {
    out.push(node);
    return out;
  }
  for (const v of Array.isArray(node) ? node : Object.values(node)) envelopes(v, out);
  return out;
}

const failures = [];
let ledgers = 0;
let transactions = 0;
let checks = 0;
let passed = 0;
const check = (ledger, name, ok, detail) => {
  checks++;
  if (ok) passed++;
  else if (failures.length < 50) failures.push({ ledger, check: name, detail });
};
for (const path of files) {
  const raw = readFileSync(path);
  let batch;
  try {
    batch = xdr.LedgerCloseMetaBatch.fromXDR(raw);
  } catch (err) {
    check(basename(path), 'decode', false, String(err.message ?? err).slice(0, 200));
    continue;
  }
  const again = Buffer.from(batch.toXDR());
  check(basename(path), 'reencode', again.equals(raw), `${again.length} vs ${raw.length} bytes`);
  for (const lcm of batch.ledgerCloseMetas) {
    ledgers++;
    const body = lcm.v2 ?? lcm.v1 ?? lcm.v0;
    const seq = String(body.ledgerHeader.header.ledgerSeq);
    const want = body.txProcessing.map((t) => hex(t.result.transactionHash));
    const got = new Set();
    const envs = envelopes(body.txSet);
    for (const env of envs) {
      try {
        got.add(hex(TransactionBuilder.fromXDR(Buffer.from(env.toXDR()).toString('base64'), opt.passphrase).hash()));
      } catch (err) {
        got.add(`error: ${err.message}`);
      }
    }
    transactions += want.length;
    for (const h of want) check(seq, 'tx_hash', got.has(h), h);
    check(seq, 'tx_count', envs.length === want.length, `${envs.length} envelopes, ${want.length} results`);
  }
}
console.log(JSON.stringify({ sdk: 'javascript', package: '@stellar/stellar-sdk', version, ledgers, transactions, checks, passed, failures }));
