// Network driver over a standalone stellar-core (RUN_STANDALONE, MANUAL_CLOSE).
// No RPC, no Docker: transactions go to core's HTTP /tx, ledgers are closed
// with /manualclose, entries come from the query server, and LedgerCloseMeta
// is read straight from core's METADATA_OUTPUT_STREAM: the canonical output.
import { execFileSync, spawn } from 'node:child_process';
import { request } from 'node:http';
import { closeSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Account, Keypair, Operation, SorobanDataBuilder, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { storeLedger, txFromLedger } from '../../lib/ledger.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const STANDALONE = 'Standalone Network ; February 2017';

export async function coreDriver({ workdir, binary = 'stellar-core', protocol, httpPort = 11826, generator }) {
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  const nodeSeed = Keypair.random().secret();
  writeFileSync(
    join(workdir, 'core.cfg'),
    `RUN_STANDALONE=true
MANUAL_CLOSE=true
NETWORK_PASSPHRASE="${STANDALONE}"
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
  // closeTime. Under MANUAL_CLOSE core's virtual clock skips ahead to its next
  // timer whenever it idles, so it runs well ahead of wall time; when it
  // refuses a time as too early it reports its "now", and we retry with a
  // margin past it. Close times on a generated network are therefore ahead of
  // wall-clock time.
  let lastCloseTime = 0;
  async function close() {
    let target = Math.max(lastCloseTime + 1, Math.ceil(Date.now() / 1000) + 2);
    for (let attempt = 0; ; attempt++) {
      const r = await call(`${http}/manualclose?closeTime=${target}`);
      const reply = typeof r === 'string' ? r : JSON.stringify(r);
      if (/Manually closed ledger/.test(reply)) break;
      const now = Number(reply.match(/now=(\d+)/)?.[1]);
      if (attempt > 4 || !now) throw new Error(`manualclose refused: ${reply.slice(0, 300)}`);
      target = Math.max(target, now + 120);
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
  const root = Keypair.master(STANDALONE);
  const accountKey = (kp) => xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: kp.xdrAccountId() }));
  async function account(kp) {
    const e = await entry(accountKey(kp));
    return new Account(kp.publicKey(), e.data.account.seqNum.toString());
  }

  async function submitTx(tx) {
    return submitEnvelope(tx.toEnvelope().toXDR('base64'));
  }

  async function submitEnvelope(envelopeB64) {
    const tx = TransactionBuilder.fromXDR(envelopeB64, STANDALONE);
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
    storeLedger('local', seq, Buffer.from(batch.toXDR()), `stellar-core ${generator.core_version} standalone METADATA_OUTPUT_STREAM`);
    return {
      hash,
      ledger: seq,
      closedAt: new Date(Number(header.scpValue.closeTime) * 1000).toISOString(),
      envelope: envelopeB64,
      meta: txFromLedger(lcm, hash).meta,
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
      for (const value of Object.values(entry)) {
        if (!value || typeof value !== 'object') continue;
        for (const [k, v] of Object.entries(value)) {
          if (!/^(ledger|tx)Max/.test(k)) continue;
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
    const lines = execFileSync(binary, ['get-settings-upgrade-txs', root.publicKey(), rootSeq, STANDALONE, '--xdr', upgrade, '--signtxs', '--add-resource-fee', '100000000'], {
      input: root.secret() + '\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const key = lines.pop();
    for (let i = 0; i < lines.length; i += 2) await submitEnvelope(lines[i]);
    await call(`${http}/upgrades?mode=set&upgradetime=1970-01-01T00:00:00Z&configupgradesetkey=${encodeURIComponent(key)}`);
    await close();
    const limits = (await call(`${http}/sorobaninfo?format=basic`)).tx;
    if (limits.max_footprint_size < 3 * factor) throw new Error(`Soroban settings upgrade did not apply: ${JSON.stringify(limits)}`);
    return limits;
  }

  const sorobanLimits = await raiseSorobanLimits(10);
  return {
    sorobanLimits,
    name: 'local',
    passphrase: STANDALONE,
    protocolVersion: version,
    async fund(kp) {
      const tx = new TransactionBuilder(await account(root), { fee: '100', networkPassphrase: STANDALONE })
        .addOperation(Operation.createAccount({ destination: kp.publicKey(), startingBalance: '10000' }))
        .setTimeout(0)
        .build();
      tx.sign(root);
      await submitTx(tx);
    },
    async submit(kp, op, { soroban } = {}) {
      const b = new TransactionBuilder(await account(kp), { fee: '100', networkPassphrase: STANDALONE }).addOperation(op).setTimeout(0);
      if (soroban) {
        // Explicit footprint and generous resources: there is no simulator here.
        b.setSorobanData(
          new SorobanDataBuilder()
            .setFootprint(soroban.readOnly ?? [], soroban.readWrite ?? [])
            .setResources(soroban.instructions ?? 2_000_000, 10_000, 10_000)
            .setResourceFee(50_000_000)
            .build(),
        );
      }
      const tx = b.build();
      tx.sign(kp);
      return submitTx(tx);
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
