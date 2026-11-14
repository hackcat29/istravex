// Network driver over Stellar RPC + friendbot (public testnet).
// Soroban transactions are simulated (prepareTransaction); meta and ledgers
// come from getLedgers, the canonical copy.
import { BASE_FEE, TransactionBuilder, rpc, xdr } from '@stellar/stellar-sdk';
import { ledgerFromBatch, storeLedger, txFromLedger } from '../../lib/ledger.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function rpcDriver({ name, rpcUrl, friendbotUrl, passphrase, allowHttp = false }) {
  const server = new rpc.Server(rpcUrl, { allowHttp });
  const { protocolVersion } = await server.getLatestLedger();

  async function ledger(seq) {
    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLedgers', params: { startLedger: seq, pagination: { limit: 1 } } }),
    });
    const l = (await r.json()).result.ledgers[0];
    const batch = new xdr.LedgerCloseMetaBatch({ startSequence: seq, endSequence: seq, ledgerCloseMetas: [xdr.LedgerCloseMeta.fromXDR(l.metadataXdr, 'base64')] });
    storeLedger(name, seq, Buffer.from(batch.toXDR()), `${rpcUrl}#getLedgers(${seq})`);
    return ledgerFromBatch(batch, seq);
  }

  return {
    name,
    passphrase,
    protocolVersion,
    async fund(kp) {
      const r = await fetch(`${friendbotUrl}?addr=${kp.publicKey()}`);
      if (!r.ok) throw new Error(`friendbot ${r.status}`);
    },
    async submit(kp, op, { soroban } = {}) {
      const account = await server.getAccount(kp.publicKey());
      let tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase }).addOperation(op).setTimeout(60).build();
      if (soroban) tx = await server.prepareTransaction(tx);
      tx.sign(kp);
      const sent = await server.sendTransaction(tx);
      if (sent.status === 'ERROR') throw new Error(`send failed: ${sent.errorResult?.toXDR('base64')}`);
      for (let i = 0; i < 60; i++) {
        const res = await server.getTransaction(sent.hash);
        if (res.status === 'FAILED') throw new Error(`tx failed ${sent.hash}`);
        if (res.status === 'SUCCESS') {
          const lcm = await ledger(res.ledger);
          return {
            hash: sent.hash,
            ledger: res.ledger,
            closedAt: new Date(Number(res.createdAt) * 1000).toISOString(),
            envelope: res.envelopeXdr.toXDR('base64'),
            meta: txFromLedger(lcm, sent.hash).meta,
          };
        }
        await sleep(1000);
      }
      throw new Error(`timeout ${sent.hash}`);
    },
    async accountEntry(kp) {
      const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: kp.xdrAccountId() }));
      const { entries } = await server.getLedgerEntries(key);
      return { b64: entries[0].val.toXDR('base64'), lastModified: entries[0].lastModifiedLedgerSeq };
    },
    source: (res) => ({ kind: 'captured', network_endpoint: rpcUrl, ledger: res.ledger, tx_hash: res.hash, closed_at: res.closedAt }),
    async close() {},
  };
}
