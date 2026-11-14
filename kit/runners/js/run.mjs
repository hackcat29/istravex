// JavaScript conformance runner (@stellar/stellar-sdk).
//
// Per fixture: decode, byte-exact re-encode, and named "native" checks of the
// SDK's high-level forms against the fixture's expected values. Files marked
// `expect: decode_error` pass when decoding fails cleanly.
//
//   node kit/runners/js/run.mjs                      the project's pinned SDK → results/javascript.json
//   node kit/runners/js/run.mjs --sdk-dir <dir>      an SDK installed under <dir>/node_modules (no file written)
//
// kit/runners/js/matrix.mjs runs it across several SDK versions.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ROOT, RESULTS, readCorpus } from '../../lib/fixture.mjs';

/** Load @stellar/stellar-sdk from a directory that has it in node_modules. */
export async function loadSdk(dir = ROOT) {
  const req = createRequire(join(resolve(dir), 'package.json'));
  const entry = req.resolve('@stellar/stellar-sdk');
  // package.json isn't in the package's exports; read it from the install directory.
  const pkgDir = join(resolve(dir), 'node_modules', '@stellar', 'stellar-sdk');
  const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  return { sdk: await import(pathToFileURL(entry).href), version };
}

const U64_MAX = '18446744073709551615';

export function conformance(sdk, version) {
  const { Account, Address, Asset, Memo, MuxedAccount, Networks, Operation, StrKey, TransactionBuilder, getLiquidityPoolId, scValToNative, scvSortedMap, xdr } = sdk;
  const passphrase = { pubnet: Networks.PUBLIC, testnet: Networks.TESTNET, local: Networks.STANDALONE };
  const pp = (m) => m.source?.generator?.network_passphrase ?? passphrase[m.network];

  // Native checks use the SDK's own high-level forms: its XDR-JSON output
  // (JSON.stringify of a decoded value), StrKey, MuxedAccount, Asset, Memo,
  // Transaction and scValToNative.
  const json = (v) => JSON.parse(JSON.stringify(v));
  const assetString = (a) => {
    if (a === 'native') return 'native';
    const v = a.credit_alphanum4 ?? a.credit_alphanum12;
    return `${v.asset_code}:${v.issuer}`;
  };
  const sdkAsset = (a) => (a.isNative() ? 'native' : `${a.getCode()}:${a.getIssuer()}`);
  const stroops = (s) => {
    const n = BigInt(s);
    return `${n / 10_000_000n}.${(n % 10_000_000n).toString().padStart(7, '0')}`;
  };
  const innerTx = (env) => {
    const j = json(env);
    return j.tx_fee_bump ? j.tx_fee_bump.tx.inner_tx.tx.tx : j.tx.tx;
  };
  const hex = (h) => Buffer.from(h).toString('hex');
  const b64 = (v) => Buffer.from(v.toXDR()).toString('base64');
  const throws = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  /**
   * Named checks per pattern. Each returns [name, expected, observed][]; a
   * row is evaluated on its own, so one throwing check doesn't hide the rest.
   */
  const native = {
    'muxed-payment'({ manifest: m, decoded }) {
      const e = m.expected_decoded;
      const pay = () => innerTx(decoded.envelope).operations[e.op_index].body.payment;
      const muxed = () => MuxedAccount.fromAddress(pay().destination, '0');
      return [
        ['destination_muxed', e.destination_muxed, () => pay().destination],
        ['muxed_id', e.muxed_id, () => muxed().id()],
        ['destination_account', e.destination_account, () => muxed().baseAccount().accountId()],
        ['asset', e.asset, () => assetString(pay().asset)],
        ['amount', e.amount, () => stroops(pay().amount)],
      ];
    },
    'fee-bump'({ manifest: m, blobs }) {
      const e = m.expected_decoded;
      const tx = () => TransactionBuilder.fromXDR(blobs.envelope, pp(m));
      return [
        ['tx_hash', e.tx_hash, () => hex(tx().hash())],
        ['inner_tx_hash', e.inner_tx_hash, () => hex(tx().innerTransaction.hash())],
        ['fee_source', e.fee_source, () => tx().feeSource],
        ['inner_source', e.inner_source, () => tx().innerTransaction.source],
      ];
    },
    'signed-payload-signer'({ manifest: m, decoded }) {
      const e = m.expected_decoded;
      const signer = () => json(decoded.ledger_entry).account.signers[0];
      const raw = () => Buffer.from(StrKey.decodeSignedPayload(signer().key));
      return [
        ['signer_strkey', e.signer_strkey, () => signer().key],
        ['signer_ed25519', e.signer_ed25519, () => StrKey.encodeEd25519PublicKey(raw().subarray(0, 32))],
        ['payload_hex', e.payload_hex, () => raw().subarray(36, 36 + raw().readUInt32BE(32)).toString('hex')],
        ['weight', String(e.weight), () => String(signer().weight)],
      ];
    },
    'sac-trust'({ manifest: m, decoded }) {
      const e = m.expected_indexed;
      const tl = () => trustlinesCreated(json(decoded.meta))[0];
      return [
        ['trustline_created', 'true', () => String(trustlinesCreated(json(decoded.meta)).length === 1)],
        ['account', e.account, () => tl().account_id],
        ['asset', e.asset, () => assetString(tl().asset)],
        ['limit', e.limit, () => tl().limit],
      ];
    },
    'muxed-max-id'({ manifest: m, blobs }) {
      const e = m.expected_decoded;
      const tx = () => TransactionBuilder.fromXDR(blobs.envelope, pp(m));
      const op = () => tx().operations[0];
      return [
        ['source_muxed', e.source_muxed, () => tx().source],
        ['source_muxed_id', e.source_muxed_id, () => MuxedAccount.fromAddress(tx().source, '0').id()],
        ['source_account', e.source_account, () => MuxedAccount.fromAddress(tx().source, '0').baseAccount().accountId()],
        ['destination_muxed_id', e.destination_muxed_id, () => MuxedAccount.fromAddress(op().destination, '0').id()],
        ['destination_account', e.destination_account, () => MuxedAccount.fromAddress(op().destination, '0').baseAccount().accountId()],
        ['amount', e.amount, () => op().amount],
        // js-stellar-sdk#1785: an ID that isn't canonical decimal must be
        // rejected; accepting "0x…" makes id() disagree with the M-address.
        [
          'muxed_id_input_canonical',
          'rejected',
          () => {
            try {
              const mx = new MuxedAccount(new Account(e.destination_account, '0'), `0x${BigInt(U64_MAX).toString(16)}`);
              return mx.id() === U64_MAX ? 'accepted, canonical' : `accepted: id() = ${mx.id()}`;
            } catch {
              return 'rejected';
            }
          },
        ],
        // ...and an offer ID that a double can't hold must not be rounded.
        [
          'offer_id_input_exact',
          'rejected or exact',
          () => {
            try {
              const opXdr = Operation.manageSellOffer({ selling: Asset.native(), buying: new Asset('ISTX', e.source_account), amount: '1', price: '1', offerId: 9007199254740993 });
              const got = json(opXdr).body.manage_sell_offer.offer_id;
              return String(got) === '9007199254740993' ? 'rejected or exact' : `encoded ${got}`;
            } catch {
              return 'rejected or exact';
            }
          },
        ],
      ];
    },
    'pool-issuer-order'({ manifest: m, blobs }) {
      const e = m.expected_decoded;
      const line = () => TransactionBuilder.fromXDR(blobs.envelope, pp(m)).operations[2].line;
      const [ca, ia] = e.asset_a.split(':');
      const [cb, ib] = e.asset_b.split(':');
      const A = new Asset(ca, ia);
      const B = new Asset(cb, ib);
      return [
        // js-stellar-sdk#1766: decoding a valid pool-share changeTrust throws when
        // issuers are ordered by strkey text instead of key bytes.
        ['decode_pool_share_op', `${e.asset_a}/${e.asset_b}`, () => `${sdkAsset(line().assetA)}/${sdkAsset(line().assetB)}`],
        ['asset_compare', '-1', () => String(Asset.compare(A, B))],
        ['pool_id', e.pool_id, () => hex(getLiquidityPoolId('constant_product', { assetA: A, assetB: B, fee: e.fee_bp }))],
      ];
    },
    'memo-non-utf8'({ manifest: m, blobs, decoded }) {
      const e = m.expected_decoded;
      const memoXdr = () => decoded.envelope.v1.tx.memo;
      return [
        ['memo_bytes', e.memo_hex, () => hex(memoXdr().text.bytes)],
        // js-stellar-sdk#1823: these paths must keep the bytes.
        ['memo_class_roundtrip', e.memo_hex, () => hex(Memo.fromXDRObject(memoXdr()).toXDRObject().text.bytes)],
        ['transaction_roundtrip', blobs.envelope, () => TransactionBuilder.fromXDR(blobs.envelope, pp(m)).toEnvelope().toXDR('base64')],
      ];
    },
    'max-length-vectors'({ manifest: m, decoded }) {
      const e = m.expected_decoded;
      const acct = () => json(decoded.ledger_entry).account;
      return [
        ['operation_count', String(e.operation_count), () => String(decoded.envelope.v1.tx.operations.length)],
        ['signature_count', String(e.signature_count), () => String(decoded.envelope_signatures.v1.signatures.length)],
        ['signer_count', String(e.signer_count), () => String(acct().signers.length)],
        ['thresholds', e.thresholds.join(','), () => Buffer.from(acct().thresholds, 'hex').subarray(1).join(',')],
      ];
    },
    'scmap-host-order'({ manifest: m, decoded }) {
      const e = m.expected_decoded;
      const map = () => decoded.ledger_entry.contractData.val;
      const entries = () => map().map ?? map().value;
      return [
        ['entry_count', String(e.entry_count), () => String(entries().length)],
        ['key_order_preserved', e.keys_xdr.join(','), () => entries().map((x) => b64(x.key)).join(',')],
        // js-stellar-sdk#1766: sorting must follow the host: type first, then value.
        ['sorted_map_matches_host', b64(map()), () => b64(scvSortedMap([...entries()].reverse()))],
        // js-stellar-sdk#1789: converting must keep every entry or fail loudly.
        [
          'native_keeps_every_entry',
          'all entries or an error',
          () => {
            let native;
            try {
              native = scValToNative(map());
            } catch {
              return 'all entries or an error';
            }
            const n = native instanceof Map ? native.size : Object.keys(native).length;
            return n === e.entry_count ? 'all entries or an error' : `${n} of ${e.entry_count} entries, no error`;
          },
        ],
      ];
    },
    'nested-auth'({ manifest: m, decoded }) {
      const e = m.expected_decoded;
      // Walk with an explicit stack and the host's depth limit (100), as indexers should.
      const walk = () => {
        const root = decoded.envelope.v1.tx.operations[0].body.invokeHostFunctionOp.auth[0].rootInvocation;
        let depth = 0;
        let count = 0;
        const stack = [[root, 1]];
        while (stack.length) {
          const [inv, d] = stack.pop();
          if (d > 100) throw new Error('auth tree deeper than 100 (the host\'s own limit)');
          depth = Math.max(depth, d);
          count++;
          for (const s of inv.subInvocations) stack.push([s, d + 1]);
        }
        return { depth, count, root };
      };
      return [
        ['auth_depth', String(e.auth_depth), () => String(walk().depth)],
        ['auth_invocations', String(e.auth_invocations), () => String(walk().count)],
        ['root_contract', e.root_contract, () => Address.fromScAddress(walk().root.function.contractFn.contractAddress).toString()],
        ['return_value', String(e.return_u32), () => String(json(decoded.meta).v4.soroban_meta.return_value.u32)],
      ];
    },
    'muxed-soroban-source'({ manifest: m, blobs }) {
      const e = m.expected_decoded;
      const tx = () => TransactionBuilder.fromXDR(blobs.envelope, pp(m));
      return [
        ['source_account', e.source_account, () => MuxedAccount.fromAddress(tx().source, '0').baseAccount().accountId()],
        ['source_muxed_id', e.source_muxed_id, () => MuxedAccount.fromAddress(tx().source, '0').id()],
        ['operation', e.operation, () => tx().operations[0].type],
      ];
    },
  };

  /** Trustlines created anywhere in a TransactionMeta (XDR-JSON form, v2–v4). */
  function trustlinesCreated(metaJson) {
    const body = metaJson.v4 ?? metaJson.v3 ?? metaJson.v2;
    return body.operations
      .flatMap((op) => op.changes)
      .filter((c) => c.created?.data?.trustline)
      .map((c) => c.created.data.trustline);
  }

  // LedgerEntryChanges is an XDR typedef (an array) with no JS class; its bytes
  // are identical to OperationMeta (a struct with one LedgerEntryChanges field).
  const codec = (type) => xdr[type] ?? { LedgerEntryChanges: xdr.OperationMeta }[type];

  const results = readCorpus().map(({ manifest, blobs }) => {
    const detail = [];
    const failed = [];
    // Bytes a decoder must refuse: pass when every one fails to decode.
    const negative = manifest.files.filter((f) => f.expect === 'decode_error');
    if (negative.length === manifest.files.length) {
      const accepted = negative.filter((f) => !throws(() => codec(f.xdr_type).fromXDR(blobs[f.name], 'base64')));
      for (const f of accepted) {
        failed.push(`rejects:${f.name}`);
        detail.push(`${f.name}: decoded, but must be rejected`);
      }
      return { fixture: manifest.id, checks: { decode: accepted.length ? 'fail' : 'pass', reencode: 'n/a', native: 'n/a' }, failed, detail };
    }
    const checks = { decode: 'fail', reencode: 'fail', native: 'fail' };
    const decoded = {};
    try {
      for (const f of manifest.files) decoded[f.name] = codec(f.xdr_type).fromXDR(blobs[f.name], 'base64');
      checks.decode = 'pass';
      const bad = manifest.files.filter((f) => decoded[f.name].toXDR('base64') !== blobs[f.name]);
      checks.reencode = bad.length ? 'fail' : 'pass';
      if (bad.length) detail.push(`re-encode differs: ${bad.map((f) => f.name).join(', ')}`);
      const rows = native[manifest.pattern]({ manifest, blobs, decoded });
      for (const [name, expected, observe] of rows) {
        let got;
        try {
          got = observe();
        } catch (err) {
          got = `threw: ${String(err.message ?? err).slice(0, 120)}`;
        }
        if (String(got) !== String(expected)) {
          failed.push(name);
          detail.push(`${name}: expected ${String(expected).slice(0, 80)}, got ${String(got).slice(0, 120)}`);
        }
      }
      checks.native = failed.length ? 'fail' : 'pass';
    } catch (err) {
      detail.push(String(err.message ?? err));
    }
    return { fixture: manifest.id, checks, failed, detail };
  });

  // Precision probe: what JavaScript's Number does to every wide integer in the corpus.
  const wide = (o) => Object.values(o ?? {}).filter((v) => typeof v === 'string' && /^\d{16,20}$/.test(v));
  const probes = [...new Set(readCorpus().flatMap(({ manifest }) => [...wide(manifest.expected_decoded), ...wide(manifest.expected_indexed)]))]
    .sort()
    .map((s) => ({ input: s, number: String(Number(s)), exact: String(Number(s)) === s }));

  return { sdk: 'javascript', package: '@stellar/stellar-sdk', version, runtime: `node ${process.versions.node}`, results, probes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values: opt } = parseArgs({ options: { 'sdk-dir': { type: 'string' } } });
  const { sdk, version } = await loadSdk(opt['sdk-dir'] ?? ROOT);
  const out = conformance(sdk, version);
  if (!opt['sdk-dir']) writeFileSync(join(RESULTS, 'javascript.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`@stellar/stellar-sdk ${version}`);
  for (const r of out.results) console.log(r.fixture.padEnd(44), JSON.stringify(r.checks), r.detail.join('; '));
}
