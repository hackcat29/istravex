// Scenarios that produce CAP-0040 and CAP-0073 ledger data and capture what
// the ledger recorded. They run on any network driver:
//   drivers/rpc.mjs   public testnet (kit/capture/testnet.mjs)
//   drivers/core.mjs  pinned standalone stellar-core (kit/capture/generate.mjs)
import { randomBytes } from 'node:crypto';
import { Address, Asset, Keypair, Operation, StrKey, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { writeFixture } from '../lib/fixture.mjs';

const accountKey = (kp) => xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: kp.xdrAccountId() }));
const instanceKey = (contractId) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
const trustlineKey = (kp, asset) => xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId: kp.xdrAccountId(), asset: asset.toTrustLineXDRObject() }));

export async function runScenarios(d) {
  const out = [];

  // ── CAP-0040: account with an ed25519 signed-payload signer ────────────
  {
    const account = Keypair.random();
    const signer = Keypair.random();
    await d.fund(account);
    const payload = randomBytes(32);
    const P = StrKey.encodeSignedPayload(new xdr.SignerKeyEd25519SignedPayload({ ed25519: signer.rawPublicKey(), payload }).toXDR());
    const res = await d.submit(account, Operation.setOptions({ signer: { ed25519SignedPayload: P, weight: 1 } }));
    const entry = await d.accountEntry(account);
    out.push(
      writeFixture({
        id: `cap40-signed-payload-signer-${d.name}-0001`,
        cap_ids: ['CAP-0040'],
        protocol_version: d.protocolVersion,
        network: d.name,
        xdr_path: 'account.signers[0].key.ed25519SignedPayload',
        source: { ...d.source(res), ledger_entry_at: entry.lastModified },
        expected_decoded: { account: account.publicKey(), signer_strkey: P, signer_ed25519: signer.publicKey(), payload_hex: payload.toString('hex'), weight: 1 },
        expected_indexed: { account: account.publicKey(), signer_added: P, weight: 1 },
        files: {
          ledger_entry: { xdr_type: 'LedgerEntryData', b64: entry.b64 },
          envelope: { xdr_type: 'TransactionEnvelope', b64: res.envelope },
        },
      }),
    );
  }

  // ── CAP-0073: trustline created by the SAC `trust` function ───────────
  {
    const issuer = Keypair.random();
    const holder = Keypair.random();
    await d.fund(issuer);
    await d.fund(holder);
    const asset = new Asset('ISTX', issuer.publicKey());
    const contract = asset.contractId(d.passphrase);
    await d.submit(issuer, Operation.createStellarAssetContract({ asset }), {
      soroban: { readOnly: [accountKey(issuer)], readWrite: [instanceKey(contract)] },
    });
    const args = [nativeToScVal(holder.publicKey(), { type: 'address' })];
    // The holder is the transaction source, so source-account credentials authorise trust().
    const auth = [
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: 'trust', args }),
          ),
          subInvocations: [],
        }),
      }),
    ];
    const res = await d.submit(holder, Operation.invokeContractFunction({ contract, function: 'trust', args, auth }), {
      soroban: { readOnly: [instanceKey(contract), accountKey(issuer)], readWrite: [accountKey(holder), trustlineKey(holder, asset)] },
    });
    out.push(
      writeFixture({
        id: `cap73-sac-trust-${d.name}-0001`,
        cap_ids: ['CAP-0073'],
        protocol_version: d.protocolVersion,
        network: d.name,
        xdr_path: 'operations[0].changes[*].created.data.trustLine',
        source: { ...d.source(res), sac_contract: contract },
        expected_decoded: { tx_hash: res.hash, function: 'trust', contract },
        expected_indexed: {
          trustline_created: true,
          account: holder.publicKey(),
          asset: `ISTX:${issuer.publicKey()}`,
          limit: '9223372036854775807',
          classic_change_trust_ops: 0,
        },
        files: {
          meta: { xdr_type: 'TransactionMeta', b64: res.meta },
          envelope: { xdr_type: 'TransactionEnvelope', b64: res.envelope },
        },
      }),
    );
  }
  return out;
}
