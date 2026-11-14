// Synthetic fixtures: bytes no network will produce, that a conforming
// decoder must reject without allocating or recursing without bound. Every
// file is marked `expect: decode_error`; runners pass when decoding fails
// cleanly and fail when it succeeds (or takes the process down).
//
// They're derived from generated fixtures, so they stay close to real data:
//   base-over-max-length-synthetic-0001
//     envelope_101_ops     the 100-operation envelope with a 101st operation
//     envelope_memo_29     the 28-byte memo envelope with a 29-byte memo
//   cap46-scval-limits-synthetic-0001
//     vec_count_max        an scvVec claiming 2^32 - 1 elements, then nothing
//     map_count_max        an scvMap claiming 2^32 - 1 entries, then nothing
//     vec_depth_2000       scvVec nested 2,000 deep (go-xdr's default limit is 1,500)
//
//   node kit/capture/synthetic.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { xdr } from '@stellar/stellar-sdk';
import { FIXTURES, writeFixture } from '../lib/fixture.mjs';

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const file = (id, name) => Buffer.from(readFileSync(join(FIXTURES, id, `${name}.xdr.b64`), 'utf8').trim(), 'base64');
const protocol = JSON.parse(readFileSync(join(FIXTURES, 'base-max-length-vectors-local-0001', 'manifest.json'), 'utf8')).protocol_version;

/** Offset of the operations count in an ENVELOPE_TYPE_TX envelope. */
function opsOffset(raw) {
  const tx = xdr.TransactionEnvelope.fromXDR(raw).v1.tx;
  const len = (v) => Buffer.from(v.toXDR()).length;
  return 4 + len(tx.sourceAccount) + 4 + 8 + len(tx.cond) + len(tx.memo);
}

// 101 operations: decode the real 100-op envelope, append a copy of op 0.
const hundred = file('base-max-length-vectors-local-0001', 'envelope');
const at = opsOffset(hundred);
const ops = xdr.TransactionEnvelope.fromXDR(hundred).v1.tx.operations.map((o) => Buffer.from(o.toXDR()));
if (hundred.readUInt32BE(at) !== 100) throw new Error('unexpected layout: operations count not found');
const opsEnd = at + 4 + ops.reduce((n, o) => n + o.length, 0);
const env101 = Buffer.concat([hundred.subarray(0, at), u32(101), hundred.subarray(at + 4, opsEnd), ops[0], hundred.subarray(opsEnd)]);

// A 29-byte memo: the real 28-byte memo plus one byte, padded to 4.
const memoEnv = file('base-memo-non-utf8-local-0001', 'envelope');
const memoTx = xdr.TransactionEnvelope.fromXDR(memoEnv).v1.tx;
const memoAt = 4 + Buffer.from(memoTx.sourceAccount.toXDR()).length + 4 + 8 + Buffer.from(memoTx.cond.toXDR()).length;
if (memoEnv.readUInt32BE(memoAt) !== 1 || memoEnv.readUInt32BE(memoAt + 4) !== 28) throw new Error('unexpected layout: memo text not found');
const memoBytes = memoEnv.subarray(memoAt + 8, memoAt + 8 + 28);
const env29 = Buffer.concat([memoEnv.subarray(0, memoAt + 4), u32(29), memoBytes, Buffer.from([0x21, 0, 0, 0]), memoEnv.subarray(memoAt + 8 + 28)]);

writeFixture({
  id: 'base-over-max-length-synthetic-0001',
  cap_ids: [],
  protocol_version: protocol,
  network: 'synthetic',
  synthetic: true,
  xdr_path: 'operations<100> with 101 entries; memo text<28> with 29 bytes',
  source: {
    kind: 'synthetic',
    derived_from: 'base-max-length-vectors-local-0001, base-memo-non-utf8-local-0001',
    description: 'Real envelopes from the generated network, re-encoded one element past a bounded XDR array or string maximum.',
  },
  expected_decoded: { decode_error: true },
  sightings: ['stellar/rs-stellar-xdr#598'],
  files: {
    envelope_101_ops: { xdr_type: 'TransactionEnvelope', b64: env101.toString('base64'), expect: 'decode_error' },
    envelope_memo_29: { xdr_type: 'TransactionEnvelope', b64: env29.toString('base64'), expect: 'decode_error' },
  },
});

// ScVal limits. SCV_VEC = 16, SCV_MAP = 17 (each an optional: present = 1), SCV_VOID = 1.
const vecCountMax = Buffer.concat([u32(16), u32(1), u32(0xffffffff)]);
const mapCountMax = Buffer.concat([u32(17), u32(1), u32(0xffffffff)]);
const DEPTH = 2000;
const deep = Buffer.concat([...Array.from({ length: DEPTH }, () => Buffer.concat([u32(16), u32(1), u32(1)])), u32(1)]);

writeFixture({
  id: 'cap46-scval-limits-synthetic-0001',
  cap_ids: ['CAP-0046'],
  protocol_version: protocol,
  network: 'synthetic',
  synthetic: true,
  xdr_path: 'ScVal: vec and map length prefixes of 2^32 - 1 with no elements; a vec nested 2,000 deep',
  source: {
    kind: 'synthetic',
    description:
      'Hand-built ScVal encodings. A decoder that reserves capacity from the length prefix allocates for 4 billion elements; one without a depth limit recurses 2,000 levels.',
  },
  expected_decoded: { decode_error: true, depth: DEPTH },
  sightings: ['stellar/rs-stellar-xdr#581', 'stellar/rs-stellar-xdr#598'],
  files: {
    vec_count_max: { xdr_type: 'ScVal', b64: vecCountMax.toString('base64'), expect: 'decode_error' },
    map_count_max: { xdr_type: 'ScVal', b64: mapCountMax.toString('base64'), expect: 'decode_error' },
    vec_depth_2000: { xdr_type: 'ScVal', b64: deep.toString('base64'), expect: 'decode_error' },
  },
});
