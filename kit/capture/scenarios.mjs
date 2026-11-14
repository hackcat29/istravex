// Scenarios that produce CAP-0040 and CAP-0073 ledger data on a live network
// and capture what the ledger recorded. Used by:
//   kit/capture/testnet.mjs   public testnet (whatever core SDF runs)
//   kit/capture/generate.mjs  local network from a digest-pinned stellar/quickstart
import { randomBytes } from 'node:crypto';
import { Asset, BASE_FEE, Keypair, Operation, StrKey, TransactionBuilder, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import { writeFixture } from '../lib/fixture.mjs';
import { ledgerFromBatch, storeLedger, txFromLedger } from '../lib/ledger.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ name: 'testnet' | 'local', rpcUrl: string, friendbotUrl: string, passphrase: string,
 *           source: object, allowHttp?: boolean }} net
 */
export async function runScenarios(net) {
  const server = new rpc.Server(net.rpcUrl, { allowHttp: net.allowHttp });

  async function fund(kp) {
    const r = await fetch(`${net.friendbotUrl}?addr=${kp.publicKey()}`);
    if (!r.ok) throw new Error(`friendbot ${r.status}`);
  }

  async function submit(kp, op, { soroban = false } = {}) {
    const account = await server.getAccount(kp.publicKey());
    let tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net.passphrase }).addOperation(op).setTimeout(60).build();
    if (soroban) tx = await server.prepareTransaction(tx);
    tx.sign(kp);
    const sent = await server.sendTransaction(tx);
    if (sent.status === 'ERROR') throw new Error(`send failed: ${sent.errorResult?.toXDR('base64')}`);
    for (let i = 0; i < 60; i++) {
      const res = await server.getTransaction(sent.hash);
      if (res.status === 'SUCCESS') return { ...res, hash: sent.hash };
      if (res.status === 'FAILED') throw new Error(`tx failed ${sent.hash}`);
      await sleep(1000);
    }
    throw new Error(`timeout ${sent.hash}`);
  }

  /** Fetch the closing ledger, store it in corpus/ledgers, and return it. */
  async function captureLedger(seq) {
    const r = await fetch(net.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLedgers', params: { startLedger: seq, pagination: { limit: 1 } } }),
    });
    const l = (await r.json()).result.ledgers[0];
    const batch = new xdr.LedgerCloseMetaBatch({ startSequence: seq, endSequence: seq, ledgerCloseMetas: [xdr.LedgerCloseMeta.fromXDR(l.metadataXdr, 'base64')] });
    storeLedger(net.name, seq, Buffer.from(batch.toXDR()), `${net.rpcUrl}#getLedgers(${seq})`);
    return ledgerFromBatch(batch, seq);
  }

  const source = (res) => ({
    ...net.source,
    network_endpoint: net.rpcUrl,
    ledger: res.ledger,
    tx_hash: res.hash,
    closed_at: new Date(Number(res.createdAt) * 1000).toISOString(),
  });
  const { protocolVersion } = await server.getLatestLedger();
  const out = [];

  // ── CAP-0040: account with an ed25519 signed-payload signer ────────────
  {
    const account = Keypair.random();
    const signer = Keypair.random();
    await fund(account);
    const payload = randomBytes(32);
    const P = StrKey.encodeSignedPayload(new xdr.SignerKeyEd25519SignedPayload({ ed25519: signer.rawPublicKey(), payload }).toXDR());
    const res = await submit(account, Operation.setOptions({ signer: { ed25519SignedPayload: P, weight: 1 } }));
    await captureLedger(res.ledger);
    const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: account.xdrAccountId() }));
    const { entries } = await server.getLedgerEntries(key);
    out.push(
      writeFixture({
        id: `cap40-signed-payload-signer-${net.name}-0001`,
        cap_ids: ['CAP-0040'],
        protocol_version: protocolVersion,
        network: net.name,
        xdr_path: 'account.signers[0].key.ed25519SignedPayload',
        source: { ...source(res), ledger_entry_at: entries[0].lastModifiedLedgerSeq },
        expected_decoded: { account: account.publicKey(), signer_strkey: P, signer_ed25519: signer.publicKey(), payload_hex: payload.toString('hex'), weight: 1 },
        expected_indexed: { account: account.publicKey(), signer_added: P, weight: 1 },
        files: {
          ledger_entry: { xdr_type: 'LedgerEntryData', b64: entries[0].val.toXDR('base64') },
          envelope: { xdr_type: 'TransactionEnvelope', b64: res.envelopeXdr.toXDR('base64') },
        },
      }),
    );
  }

  // ── CAP-0073: trustline created by the SAC `trust` function ───────────
  {
    const issuer = Keypair.random();
    const holder = Keypair.random();
    await Promise.all([fund(issuer), fund(holder)]);
    const asset = new Asset('ISTX', issuer.publicKey());
    await submit(issuer, Operation.createStellarAssetContract({ asset }), { soroban: true });
    const contract = asset.contractId(net.passphrase);
    const res = await submit(
      holder,
      Operation.invokeContractFunction({ contract, function: 'trust', args: [nativeToScVal(holder.publicKey(), { type: 'address' })] }),
      { soroban: true },
    );
    // Meta from the canonical ledger: getTransaction's copy carries node-local diagnostics.
    const meta = txFromLedger(await captureLedger(res.ledger), res.hash).meta;
    out.push(
      writeFixture({
        id: `cap73-sac-trust-${net.name}-0001`,
        cap_ids: ['CAP-0073'],
        protocol_version: protocolVersion,
        network: net.name,
        xdr_path: 'operations[0].changes[*].created.data.trustLine',
        source: { ...source(res), sac_contract: contract },
        expected_decoded: { tx_hash: res.hash, function: 'trust', contract },
        expected_indexed: {
          trustline_created: true,
          account: holder.publicKey(),
          asset: `ISTX:${issuer.publicKey()}`,
          limit: '9223372036854775807',
          classic_change_trust_ops: 0,
        },
        files: {
          meta: { xdr_type: 'TransactionMeta', b64: meta },
          envelope: { xdr_type: 'TransactionEnvelope', b64: res.envelopeXdr.toXDR('base64') },
        },
      }),
    );
  }
  return out;
}
