// Network driver over a standalone stellar-core (RUN_STANDALONE, MANUAL_CLOSE).
// No RPC, no Docker: transactions go to core's HTTP /tx, ledgers are closed
// with /manualclose, entries come from the query server, and LedgerCloseMeta
// is read straight from core's METADATA_OUTPUT_STREAM: the canonical output.
//
// Deterministic: every key (including the node's) is derived from `seed`, and
// ledgers close at fixed times from CLOSE_TIME_BASE, so the same pinned binary,
// seed and passphrase reproduce every XDR byte (kit/capture/generate.mjs --check).
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { request } from 'node:http';
import { closeSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Account, Keypair, MuxedAccount, Operation, SorobanDataBuilder, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { storeLedger, txFromLedger } from '../../lib/ledger.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const STANDALONE = 'Standalone Network ; February 2017';
/**
 * Ledgers close at CLOSE_TIME_BASE + CLOSE_TIME_STEP × n. Under MANUAL_CLOSE
 * stellar-core refuses a close time earlier than its own virtual clock, which
 * jumps ahead to its next timer whenever it idles, by an amount that depends
 * on the machine: 105–299 s past the last close on an M-series Mac, about
 * 5,000 s on a GitHub Actions runner. So the base sits far in the future
 * (2100-01-01T00:00:00Z) and each step is 30 days, hundreds of times the
 * largest jump seen. Transactions carry no time bounds, so only ledger
 * headers see these times.
 */
export const CLOSE_TIME_BASE = 4102444800;
export const CLOSE_TIME_STEP = 30 * 24 * 3600;

/** 32 bytes derived from the seed and a label: the source of every key and payload. */
export const derive = (seed, label) => createHash('sha256').update(`istravex:${seed}:${label}`).digest();

export async function coreDriver({ workdir, binary = 'stellar-core', protocol, httpPort = 11826, generator, passphrase = STANDALONE, seed = 'istravex', name = 'local' }) {
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  const nodeSeed = Keypair.fromRawEd25519Seed(derive(seed, 'node')).secret();
  writeFileSync(
    join(workdir, 'core.cfg'),
    `RUN_STANDALONE=true
MANUAL_CLOSE=true
NETWORK_PASSPHRASE="${passphrase}"
NODE_SEED="${nodeSeed} self"
NODE_IS_VALIDATOR=true
UNSAFE_QUORUM=true
FAILURE_SAFETY=0
DATABASE="sqlite3://stellar.db"
HTTP_PORT=${httpPort}
PUBLIC_HTTP_PORT=false
HTTP_QUERY_PORT=${httpPort + 1}
QUERY_SNAPSHOT_LEDGERS=2
BUCKET_DIR_PATH="buckets"
METADATA_OUTPUT_STREAM="meta.xdr"
${process.env.ISTRAVEX_CORE_DIAGNOSTICS ? 'ENABLE_SOROBAN_DIAGNOSTIC_EVENTS=true\n' : ''}
[QUORUM_SET]
THRESHOLD_PERCENT=100
VALIDATORS=["$self"]
`,
  );
  const run = (args) =>
    new Promise((resolve, reject) => {
      const p = spawn(binary, args, { cwd: workdir, stdio: 'ignore' });
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${binary} ${args[0]} exited ${c}`))));
    });
  await run(['new-db', '--conf', 'core.cfg']);
  const log = openSync(join(workdir, 'core.log'), 'a');
  const proc = spawn(binary, ['run', '--conf', 'core.cfg'], { cwd: workdir, stdio: ['ignore', log, log] });
  // Never leave a node running behind us, even if this process crashes.
  const reap = () => proc.exitCode === null && proc.kill('SIGKILL');
  process.once('exit', reap);

  // stellar-core's HTTP servers close the socket after every response and match
  // header names case-sensitively, so fetch() (pooled connections, lowercase
  // headers) fails against them. Use node:http, one connection per request.
  function call(url, body) {
    return new Promise((resolve, reject) => {
      const headers = body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) };
      const req = request(url, { method: body === undefined ? 'GET' : 'POST', headers, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) return reject(new Error(`stellar-core ${res.statusCode} for ${url.split('?')[0]}: ${text.slice(0, 160)}`));
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  const http = `http://127.0.0.1:${httpPort}`;
  const query = `http://127.0.0.1:${httpPort + 1}`; // HTTP_QUERY_PORT
  const info = async () => (await call(`${http}/info`)).info;
  // Refuse to talk to a stale node left behind by an earlier run.
  if (await info().then(() => true, () => false)) throw new Error(`port ${httpPort} is already serving a stellar-core; stop it first`);
  for (let i = 0; ; i++) {
    try {
      if ((await info()).state === 'Synced!') break;
    } catch {}
    if (i > 120) throw new Error('stellar-core did not start');
    await sleep(500);
  }

  // ── Metadata stream: XDR record-marked LedgerCloseMeta frames ────────────
  let offset = 0;
  const metaPath = join(workdir, 'meta.xdr');
  function readFrames() {
    const fd = openSync(metaPath, 'r');
    const out = [];
    try {
      for (;;) {
        const head = Buffer.alloc(4);
        if (readSync(fd, head, 0, 4, offset) < 4) break;
        const len = head.readUInt32BE(0) & 0x7fffffff;
        const body = Buffer.alloc(len);
        if (readSync(fd, body, 0, len, offset + 4) < len) break;
        offset += 4 + len;
        out.push(body);
      }
    } finally {
      closeSync(fd);
    }
    return out;
  }
  let lastSeq = (await info()).ledger.num;
  // A bare /manualclose intermittently aborts stellar-core 30.0.0
  // (assert `t >= mVirtualNow`, util/Timer.cpp:287, via
  // ApplicationImpl::manualClose), so pass an explicit, strictly increasing
  // closeTime. Fixed times (CLOSE_TIME_BASE + 5 s steps) keep ledger headers,
  // and so every hash, identical between runs.
  let lastCloseTime = CLOSE_TIME_BASE;
  async function close() {
    const target = lastCloseTime + CLOSE_TIME_STEP;
    const r = await call(`${http}/manualclose?closeTime=${target}`);
    const reply = typeof r === 'string' ? r : JSON.stringify(r);
    if (!/Manually closed ledger/.test(reply)) {
      // Never fall back to core's clock: that would make the output depend on
      // the machine. A refusal here means CLOSE_TIME_STEP is too small.
      const now = Number(reply.match(/now=(\d+)/)?.[1]);
      throw new Error(`manualclose refused closeTime=${target} (core's clock is ${now - lastCloseTime} s past the last close; CLOSE_TIME_STEP is ${CLOSE_TIME_STEP} s): ${reply.slice(0, 300)}`);
    }
    lastCloseTime = target;
    for (let i = 0; i < 100; i++) {
      const frames = readFrames();
      const metas = frames.map((b) => ({ raw: b, lcm: xdr.LedgerCloseMeta.fromXDR(b) }));
      const latest = metas.at(-1);
      if (latest) {
        const seq = (latest.lcm.v2 ?? latest.lcm.v1 ?? latest.lcm.v0).ledgerHeader.header.ledgerSeq;
        if (seq > lastSeq) {
          lastSeq = seq;
          return latest;
        }
      }
      await sleep(50);
    }
    throw new Error('no LedgerCloseMeta after manualclose');
  }
  readFrames(); // skip genesis-era frames

  // Upgrade the fresh network to the target protocol in one step.
  await call(`${http}/upgrades?mode=set&upgradetime=1970-01-01T00:00:00Z&protocolversion=${protocol}`);
  await close();
  const version = (await info()).ledger.version;
  if (version !== protocol) throw new Error(`upgrade to ${protocol} failed (at ${version})`);

  async function entry(key) {
    const e = (await call(`${query}/getledgerentry`, `key=${encodeURIComponent(key.toXDR('base64'))}`)).entries[0];
    if (!e?.entry) throw new Error('ledger entry not found');
    return xdr.LedgerEntry.fromXDR(e.entry, 'base64');
  }
  const root = Keypair.master(passphrase);
  const accountKey = (kp) => xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: kp.xdrAccountId() }));
  async function account(kp) {
    const e = await entry(accountKey(kp));
    return new Account(kp.publicKey(), e.data.account.seqNum.toString());
  }

  async function submitTx(tx) {
    return submitEnvelope(tx.toEnvelope().toXDR('base64'));
  }

  async function submitEnvelope(envelopeB64) {
    const tx = TransactionBuilder.fromXDR(envelopeB64, passphrase);
    const hash = Buffer.from(tx.hash()).toString('hex');
    const r = await call(`${http}/tx?blob=${encodeURIComponent(envelopeB64)}`);
    if (r.status !== 'PENDING') throw new Error(`core rejected tx: ${r.status} ${r.error ?? ''}`);
    const { raw, lcm } = await close();
    const seq = (lcm.v2 ?? lcm.v1).ledgerHeader.header.ledgerSeq;
    const header = (lcm.v2 ?? lcm.v1).ledgerHeader.header;
    const tp = (lcm.v2 ?? lcm.v1).txProcessing.find((t) => t.result.transactionHash.toXDR('hex') === hash);
    if (!tp) throw new Error(`tx ${hash} not in ledger ${seq}`);
    const code = tp.result.result.result.type;
    if (code !== 'txSuccess') throw new Error(`tx ${hash} failed: ${code} ${tp.result.result.toXDR('base64')}`);
    const batch = new xdr.LedgerCloseMetaBatch({ startSequence: seq, endSequence: seq, ledgerCloseMetas: [xdr.LedgerCloseMeta.fromXDR(raw)] });
    storeLedger(name, seq, Buffer.from(batch.toXDR()), `stellar-core ${generator.core_version} standalone METADATA_OUTPUT_STREAM`);
    return {
      hash,
      ledger: seq,
      closedAt: new Date(Number(header.scpValue.closeTime) * 1000).toISOString(),
      envelope: envelopeB64,
      ...txFromLedger(lcm, hash), // result, meta, fee_meta: consensus copies
    };
  }

  /**
   * A fresh network starts with Soroban's initial limits (3-entry footprints,
   * 3,200-byte reads and writes, 1 Soroban tx per ledger). Raise every
   * per-ledger and per-tx maximum by `factor` with a real settings upgrade, the
   * way network operators do: stellar-core builds and signs the upgrade
   * transactions, we submit them and arm the upgrade.
   */
  async function raiseSorobanLimits(factor) {
    const current = String(await call(`${http}/sorobaninfo?format=upgrade_xdr`)).trim();
    const set = xdr.ConfigUpgradeSet.fromXDR(current, 'base64');
    // Upload only the entries we change: the full set (~4 KB with the cost
    // parameter tables) is itself larger than the initial 2,000-byte
    // contract-data entry limit it is stored under.
    set.updatedEntry = set.updatedEntry.filter((entry) => {
      let changed = false;
      // Size caps stored directly on the entry (contractMaxSizeBytes: the
      // largest Wasm). The probe contract is 4 KB, above the initial 2,000.
      for (const [k, v] of Object.entries(entry)) {
        if (typeof v === 'number' && /MaxSizeBytes$/.test(k)) {
          entry[k] = v * factor;
          changed = true;
        }
      }
      for (const value of Object.values(entry)) {
        if (!value || typeof value !== 'object') continue;
        for (const [k, v] of Object.entries(value)) {
          if (!/^(ledger|tx)Max|^txMemoryLimit$/.test(k)) continue;
          if (typeof v === 'bigint') value[k] = v * BigInt(factor);
          else if (typeof v === 'number') value[k] = v * factor;
          else continue;
          changed = true;
        }
      }
      return changed;
    });
    const upgrade = set.toXDR('base64');
    const rootSeq = (await account(root)).sequenceNumber();
    const lines = execFileSync(binary, ['get-settings-upgrade-txs', root.publicKey(), rootSeq, passphrase, '--xdr', upgrade, '--signtxs', '--add-resource-fee', '100000000'], {
      input: root.secret() + '\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const { envelopes, key } = deterministicUpgrade(lines, rootSeq);
    for (const env of envelopes) await submitEnvelope(env);
    await call(`${http}/upgrades?mode=set&upgradetime=1970-01-01T00:00:00Z&configupgradesetkey=${encodeURIComponent(key)}`);
    await close();
    const limits = (await call(`${http}/sorobaninfo?format=basic`)).tx;
    if (limits.max_footprint_size < 3 * factor) throw new Error(`Soroban settings upgrade did not apply: ${JSON.stringify(limits)}`);
    return limits;
  }

  /**
   * get-settings-upgrade-txs deploys its upgrade contract with a random salt,
   * which would make every later ledger differ between runs. Swap in a salt
   * derived from the seed: replace the salt and the contract ID it implies
   * (both random 32-byte values, so a byte-level swap can't hit anything
   * else) in each transaction and in the upgrade key, then re-sign as root.
   */
  function deterministicUpgrade(lines, rootSeq) {
    const key = lines.pop();
    const envelopes = lines.filter((_, i) => i % 2 === 0);
    let oldSalt;
    for (const b64 of envelopes) {
      const env = xdr.TransactionEnvelope.fromXDR(b64, 'base64');
      for (const op of env.v1.tx.operations) {
        const hf = op.body.invokeHostFunctionOp?.hostFunction;
        const create = hf?.createContract ?? hf?.createContractV2;
        if (create) oldSalt = Buffer.from(create.contractIdPreimage.fromAddress.salt.toXDR());
      }
    }
    if (!oldSalt) throw new Error('get-settings-upgrade-txs: no contract deployment found');
    const newSalt = derive(seed, 'settings-upgrade-salt');
    const idOf = (salt) =>
      createHash('sha256')
        .update(
          xdr.HashIdPreimage.envelopeTypeContractId(
            new xdr.HashIdPreimageContractId({
              networkId: createHash('sha256').update(passphrase).digest(),
              contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
                new xdr.ContractIdPreimageFromAddress({ address: xdr.ScAddress.scAddressTypeAccount(root.xdrAccountId()), salt }),
              ),
            }),
          ).toXDR(),
        )
        .digest();
    const swaps = [
      [oldSalt, newSalt],
      [idOf(oldSalt), idOf(newSalt)],
    ];
    const swap = (buf) => {
      let out = Buffer.from(buf);
      for (const [from, to] of swaps) {
        for (let i = out.indexOf(from); i !== -1; i = out.indexOf(from, i + to.length)) to.copy(out, i);
      }
      return out;
    };
    const resigned = envelopes.map((b64) => {
      const env = xdr.TransactionEnvelope.fromXDR(swap(Buffer.from(b64, 'base64')));
      env.v1.signatures = [];
      const tx = TransactionBuilder.fromXDR(env.toXDR('base64'), passphrase);
      tx.sign(root);
      return tx.toEnvelope().toXDR('base64');
    });
    return { envelopes: resigned, key: swap(Buffer.from(key, 'base64')).toString('base64') };
  }

  const sorobanLimits = await raiseSorobanLimits(10);

  /**
   * Build, sign and submit one transaction.
   *   ops      an operation or a list (up to 100)
   *   muxedId  send from the M… form of `kp` with this 64-bit ID (a decimal string)
   *   signers  keypairs that sign (default: `kp`)
   *   memo     an xdr.Memo, for bytes the Memo class won't build
   *   soroban  { readOnly, readWrite, instructions } for an explicit footprint
   */
  async function submit(kp, ops, { soroban, muxedId, rawMuxedSource, signers = [kp], memo, fee } = {}) {
    const list = [ops].flat();
    let src = await account(kp);
    if (muxedId !== undefined) src = new MuxedAccount(src, muxedId);
    const b = new TransactionBuilder(src, { fee: String(fee ?? 100), networkPassphrase: passphrase }).setTimeout(0);
    for (const op of list) b.addOperation(op);
    if (soroban) {
      // Explicit footprint and generous resources: there is no simulator here.
      b.setSorobanData(
        new SorobanDataBuilder()
          .setFootprint(soroban.readOnly ?? [], soroban.readWrite ?? [])
          .setResources(soroban.instructions ?? 2_000_000, 30_000, 20_000)
          .setResourceFee(50_000_000)
          .build(),
      );
    }
    let tx = b.build();
    if (memo || rawMuxedSource !== undefined) {
      // Shapes the SDK's builder refuses but the network accepts: memo bytes
      // that aren't UTF-8, and a muxed source on a Soroban transaction. Set
      // them on the raw XDR before signing.
      const env = tx.toEnvelope();
      if (memo) env.v1.tx.memo = memo;
      if (rawMuxedSource !== undefined) {
        env.v1.tx.sourceAccount = xdr.MuxedAccount.keyTypeMuxedEd25519(
          new xdr.MuxedAccountMed25519({ id: xdr.Uint64.fromString(String(rawMuxedSource)), ed25519: kp.rawPublicKey() }),
        );
      }
      tx = TransactionBuilder.fromXDR(env.toXDR('base64'), passphrase);
    }
    for (const s of signers) tx.sign(s);
    return submitTx(tx);
  }

  return {
    sorobanLimits,
    name,
    passphrase,
    protocolVersion: version,
    deterministic: true,
    keypair: (label) => Keypair.fromRawEd25519Seed(derive(seed, `key:${label}`)),
    bytes: (label, n = 32) => derive(seed, `bytes:${label}`).subarray(0, n),
    async fund(kp, startingBalance = '10000') {
      const tx = new TransactionBuilder(await account(root), { fee: '100', networkPassphrase: passphrase })
        .addOperation(Operation.createAccount({ destination: kp.publicKey(), startingBalance }))
        .setTimeout(0)
        .build();
      tx.sign(root);
      await submitTx(tx);
    },
    submit,
    async entry(key) {
      const e = await entry(key);
      return { b64: e.data.toXDR('base64'), lastModified: e.lastModifiedLedgerSeq };
    },
    async accountEntry(kp) {
      const e = await entry(accountKey(kp));
      return { b64: e.data.toXDR('base64'), lastModified: e.lastModifiedLedgerSeq };
    },
    source: (res) => ({
      kind: 'generated',
      network_endpoint: 'stellar-core://standalone',
      ledger: res.ledger,
      tx_hash: res.hash,
      closed_at: res.closedAt,
      generator,
    }),
    async close({ keep = false } = {}) {
      process.off('exit', reap);
      proc.kill('SIGINT');
      await new Promise((r) => proc.on('close', r));
      closeSync(log);
      if (!keep) rmSync(workdir, { recursive: true, force: true });
    },
  };
}
