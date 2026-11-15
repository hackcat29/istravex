// Scenarios that put rare but valid shapes on a network and capture exactly
// what the ledger recorded. They run on a network driver:
//   drivers/rpc.mjs   public testnet (kit/capture/testnet.mjs): the CAP-0040
//                     and CAP-0073 scenarios
//   drivers/core.mjs  pinned standalone stellar-core (kit/capture/generate.mjs):
//                     every scenario, deterministically
//
// Each scenario names the upstream sightings it reproduces, so the findings
// report can tie a failing check back to the issue it came from.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Account,
  Address,
  Asset,
  MuxedAccount,
  LiquidityPoolAsset,
  LiquidityPoolId,
  Operation,
  StrKey,
  getLiquidityPoolId,
  hash,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { ROOT, writeFixture } from '../lib/fixture.mjs';

export const PROBE_WASM = join(ROOT, 'kit', 'capture', 'contracts', 'probe.wasm');
export const U64_MAX = '18446744073709551615';

const accountKey = (kp) => xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: kp.xdrAccountId() }));
const instanceKey = (contractId) => contractDataKey(contractId, xdr.ScVal.scvLedgerKeyContractInstance());
const contractDataKey = (contractId, key) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
const codeKey = (wasmHash) => xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
const trustlineKey = (kp, asset) => xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId: kp.xdrAccountId(), asset: asset.toTrustLineXDRObject() }));
const assetString = (a) => (a.isNative() ? 'native' : `${a.getCode()}:${a.getIssuer()}`);

/** The contract ID a deployer gets for a salt (HashIdPreimage ENVELOPE_TYPE_CONTRACT_ID). */
export function contractIdFor(passphrase, deployer, salt) {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(passphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({ address: new Address(deployer).toScAddress(), salt }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

const contractFn = (contract, functionName, args) =>
  xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName, args }),
  );
const sourceAccountAuth = (rootInvocation) =>
  new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation });

// ── CAP-0040: account with an ed25519 signed-payload signer ──────────────
async function signedPayloadSigner(d) {
  const account = d.keypair('cap40-account');
  const signer = d.keypair('cap40-signer');
  await d.fund(account);
  const payload = d.bytes('cap40-payload', 32);
  const P = StrKey.encodeSignedPayload(new xdr.SignerKeyEd25519SignedPayload({ ed25519: signer.rawPublicKey(), payload }).toXDR());
  const res = await d.submit(account, Operation.setOptions({ signer: { ed25519SignedPayload: P, weight: 1 } }));
  const entry = await d.accountEntry(account);
  return writeFixture({
    id: `cap40-signed-payload-signer-${d.name}-0001`,
    cap_ids: ['CAP-0040'],
    protocol_version: d.protocolVersion,
    network: d.name,
    xdr_path: 'account.signers[0].key.ed25519SignedPayload',
    source: { ...d.source(res), ledger_entry_at: entry.lastModified },
    expected_decoded: { account: account.publicKey(), signer_strkey: P, signer_ed25519: signer.publicKey(), payload_hex: Buffer.from(payload).toString('hex'), weight: 1 },
    expected_indexed: { account: account.publicKey(), signer_added: P, weight: 1 },
    sightings: ['stellar/wallet-backend#729'],
    files: {
      ledger_entry: { xdr_type: 'LedgerEntryData', b64: entry.b64 },
      envelope: { xdr_type: 'TransactionEnvelope', b64: res.envelope },
    },
  });
}

// ── CAP-0073: trustline created by the SAC `trust` function ──────────────
async function sacTrust(d) {
  const issuer = d.keypair('cap73-issuer');
  const holder = d.keypair('cap73-holder');
  await d.fund(issuer);
  await d.fund(holder);
  const asset = new Asset('ISTX', issuer.publicKey());
  const contract = asset.contractId(d.passphrase);
  await d.submit(issuer, Operation.createStellarAssetContract({ asset }), {
    soroban: { readOnly: [accountKey(issuer)], readWrite: [instanceKey(contract)] },
  });
  const args = [nativeToScVal(holder.publicKey(), { type: 'address' })];
  // The holder is the transaction source, so source-account credentials authorise trust().
  const auth = [sourceAccountAuth(new xdr.SorobanAuthorizedInvocation({ function: contractFn(contract, 'trust', args), subInvocations: [] }))];
  const res = await d.submit(holder, Operation.invokeContractFunction({ contract, function: 'trust', args, auth }), {
    soroban: { readOnly: [instanceKey(contract), accountKey(issuer)], readWrite: [accountKey(holder), trustlineKey(holder, asset)] },
  });
  return writeFixture({
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
    sightings: ['stellar/wallet-backend#731'],
    files: {
      meta: { xdr_type: 'TransactionMeta', b64: res.meta },
      envelope: { xdr_type: 'TransactionEnvelope', b64: res.envelope },
    },
  });
}

// ── CAP-0027: muxed source and a muxed destination at the maximum ID ─────
async function muxedMaxId(d) {
  const sender = d.keypair('cap27-sender');
  const recipient = d.keypair('cap27-recipient');
  await d.fund(sender);
  await d.fund(recipient);
  // 2^53 + 1: the first ID a double can't hold. The destination uses 2^64 - 1.
  const sourceId = '9007199254740993';
  const destination = new MuxedAccount(new Account(recipient.publicKey(), '0'), U64_MAX).accountId();
  const res = await d.submit(sender, Operation.payment({ destination, asset: Asset.native(), amount: '12.3456789' }), { muxedId: sourceId });
  const sourceMuxed = StrKey.encodeMed25519PublicKey(
    Buffer.concat([sender.rawPublicKey(), Buffer.from(BigInt(sourceId).toString(16).padStart(16, '0'), 'hex')]),
  );
  const participants = [sender.publicKey(), recipient.publicKey()].sort();
  return writeFixture({
    id: `cap27-muxed-max-id-${d.name}-0001`,
    cap_ids: ['CAP-0027'],
    protocol_version: d.protocolVersion,
    network: d.name,
    xdr_path: 'tx.sourceAccount, tx.operations[0].body.paymentOp.destination',
    source: d.source(res),
    expected_decoded: {
      source_muxed: sourceMuxed,
      source_account: sender.publicKey(),
      source_muxed_id: sourceId,
      destination_muxed: destination,
      destination_account: recipient.publicKey(),
      destination_muxed_id: U64_MAX,
      asset: 'native',
      amount: '12.3456789',
    },
    expected_indexed: { recipient: recipient.publicKey(), recipient_muxed_id: U64_MAX, participants },
    sightings: ['stellar/js-stellar-sdk#1785'],
    files: {
      envelope: { xdr_type: 'TransactionEnvelope', b64: res.envelope },
      meta: { xdr_type: 'TransactionMeta', b64: res.meta },
    },
  });
}

// ── CAP-0038: pool-share trustline whose issuers sort differently ────────
// Strkeys are base32: in ASCII `2`–`7` sort before `A`–`Z`, in value after.
// Pick two issuers whose strkey order is the reverse of their key-byte order.
async function poolIssuerOrder(d) {
  let a, b;
  for (let i = 0; ; i++) {
    const x = d.keypair(`cap38-issuer-x-${i}`);
    const y = d.keypair(`cap38-issuer-y-${i}`);
    const byText = x.publicKey() < y.publicKey();
    const byBytes = Buffer.compare(x.rawPublicKey(), y.rawPublicKey()) < 0;
    if (byText !== byBytes) {
      [a, b] = byBytes ? [x, y] : [y, x]; // a sorts first on the network
      break;
    }
  }
  const holder = d.keypair('cap38-holder');
  for (const kp of [a, b, holder]) await d.fund(kp);
  const assetA = new Asset('ISTX', a.publicKey());
  const assetB = new Asset('ISTX', b.publicKey());
  const pool = new LiquidityPoolAsset(assetA, assetB, 30);
  const poolId = Buffer.from(getLiquidityPoolId('constant_product', { assetA, assetB, fee: 30 })).toString('hex');
  const res = await d.submit(holder, [
    Operation.changeTrust({ asset: assetA }),
    Operation.changeTrust({ asset: assetB }),
    Operation.changeTrust({ asset: pool }),
  ]);
  const entry = await d.entry(
    xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId: holder.xdrAccountId(), asset: new LiquidityPoolId(poolId).toXDRObject() })),
  );
  return writeFixture({
    id: `cap38-pool-issuer-order-${d.name}-0001`,
    cap_ids: ['CAP-0038'],
    protocol_version: d.protocolVersion,
    network: d.name,
    xdr_path: 'tx.operations[2].body.changeTrustOp.line.liquidityPool.constantProduct',
    source: d.source(res),
    expected_decoded: {
      asset_a: assetString(assetA),
      asset_b: assetString(assetB),
      fee_bp: 30,
      pool_id: poolId,
      strkey_order_reversed: true,
      holder: holder.publicKey(),
    },
    sightings: ['stellar/js-stellar-sdk#1766'],
    files: {
      envelope: { xdr_type: 'TransactionEnvelope', b64: res.envelope },
      ledger_entry: { xdr_type: 'LedgerEntryData', b64: entry.b64 },
      meta: { xdr_type: 'TransactionMeta', b64: res.meta },
    },
  });
}

// ── Base protocol: the largest amount there is ───────────────────────────
// i64::MAX stroops: 922,337,203,685.4775807 units. A float64 holds integers
// exactly only to 2^53, so any amount above 900,719,925.4740992 units is
// rounded by code that stores amounts as doubles.
export const I64_MAX = '9223372036854775807';
async function maxAmount(d) {
  const issuer = d.keypair('max-amount-issuer');
  const holder = d.keypair('max-amount-holder');
  await d.fund(issuer);
  await d.fund(holder);
  const asset = new Asset('ISTX', issuer.publicKey());
  await d.submit(holder, Operation.changeTrust({ asset }));
  const amount = '922337203685.4775807';
  const res = await d.submit(issuer, Operation.payment({ destination: holder.publicKey(), asset, amount }));
  return writeFixture({
    id: `base-max-amount-${d.name}-0001`,
    cap_ids: [],
    protocol_version: d.protocolVersion,
    network: d.name,
    xdr_path: 'tx.operations[0].body.paymentOp.amount',
    source: d.source(res),
    expected_decoded: { amount, amount_stroops: I64_MAX, asset: assetString(asset) },
    expected_indexed: { recipient: holder.publicKey(), asset: assetString(asset), amount_stroops: I64_MAX },
    sightings: ['stellar/stellar-etl#454'],
    files: {
      envelope: { xdr_type: 'TransactionEnvelope', b64: res.envelope },
      meta: { xdr_type: 'TransactionMeta', b64: res.meta },
    },
  });
}

// ── Base protocol: memo text that is not UTF-8, at its 28-byte maximum ───
async function memoNonUtf8(d) {
  const sender = d.keypair('memo-sender');
  const recipient = d.keypair('memo-recipient');
  await d.fund(sender);
  await d.fund(recipient);
  // 0xFF and 0xFE never occur in UTF-8; ED A0 80 is a lone surrogate (U+D800)
  // in CESU-8 form; E9 is Latin-1 "é". Padded to the 28-byte maximum.
  const memoBytes = Buffer.concat([Buffer.from('istravex '), Buffer.from([0xff, 0xfe, 0xed, 0xa0, 0x80, 0xe9])]);
  const memo = Buffer.concat([memoBytes, Buffer.from('-'.repeat(28 - memoBytes.length))]);
  const res = await d.submit(sender, Operation.payment({ destination: recipient.publicKey(), asset: Asset.native(), amount: '0.0000001' }), {
    memo: xdr.Memo.memoText(memo),
  });
  return writeFixture({
    id: `base-memo-non-utf8-${d.name}-0001`,
    cap_ids: [],
    protocol_version: d.protocolVersion,
    network: d.name,
    xdr_path: 'tx.memo.text',
    source: d.source(res),
    expected_decoded: { memo_type: 'text', memo_hex: memo.toString('hex'), memo_bytes: memo.length, utf8_valid: false },
    sightings: ['stellar/js-stellar-sdk#1823'],
    files: {
      envelope: { xdr_type: 'TransactionEnvelope', b64: res.envelope },
      result: { xdr_type: 'TransactionResult', b64: res.result },
    },
  });
}

// ── Base protocol: every bounded vector at its maximum ───────────────────
// 100 operations in one transaction; 20 signers on one account, and a
// transaction from it carrying 20 signatures. (They're two transactions:
// stellar-core rejects 20 signatures checked across 100 operations with
// opBAD_AUTH part-way through.)
async function maxLengthVectors(d) {
  const payer = d.keypair('max-payer');
  const owner = d.keypair('max-owner');
  const recipient = d.keypair('max-recipient');
  await d.fund(payer, '100000');
  await d.fund(owner, '100000');
  await d.fund(recipient);
  const ops = Array.from({ length: 100 }, () => Operation.payment({ destination: recipient.publicKey(), asset: Asset.native(), amount: '0.0000001' }));
  const many = await d.submit(payer, ops, { fee: 100 * ops.length });
  const signers = Array.from({ length: 20 }, (_, i) => d.keypair(`max-signer-${i}`));
  await d.submit(owner, [
    ...signers.map((s) => Operation.setOptions({ signer: { ed25519PublicKey: s.publicKey(), weight: 1 } })),
    Operation.setOptions({ masterWeight: 0, lowThreshold: 20, medThreshold: 20, highThreshold: 20 }),
  ], { fee: 100 * 21 });
  const signed = await d.submit(owner, Operation.payment({ destination: recipient.publicKey(), asset: Asset.native(), amount: '0.0000001' }), { signers });
  const entry = await d.accountEntry(owner);
  return writeFixture({
    id: `base-max-length-vectors-${d.name}-0001`,
    cap_ids: [],
    protocol_version: d.protocolVersion,
    network: d.name,
    xdr_path: 'envelope: tx.operations (100); envelope_signatures: signatures (20); ledger_entry: account.signers (20)',
    source: { ...d.source(many), related: [{ ledger: signed.ledger, tx_hash: signed.hash, files: ['envelope_signatures', 'ledger_entry'] }] },
    expected_decoded: {
      operation_count: 100,
      signature_count: 20,
      signer_count: 20,
      master_weight: 0,
      thresholds: [20, 20, 20],
      payer: payer.publicKey(),
      account: owner.publicKey(),
    },
    files: {
      envelope: { xdr_type: 'TransactionEnvelope', b64: many.envelope },
      envelope_signatures: { xdr_type: 'TransactionEnvelope', b64: signed.envelope },
      ledger_entry: { xdr_type: 'LedgerEntryData', b64: entry.b64 },
    },
  });
}

// ── The probe contract (kit/capture/contracts/probe) ─────────────────────
async function deployProbe(d, deployer, count) {
  const wasm = readFileSync(PROBE_WASM);
  const wasmHash = createHash('sha256').update(wasm).digest();
  await d.submit(deployer, Operation.uploadContractWasm({ wasm }), { soroban: { readWrite: [codeKey(wasmHash)], instructions: 20_000_000 } });
  const ids = [];
  for (let i = 0; i < count; i++) {
    const salt = d.bytes(`probe-salt-${i}`, 32);
    const id = contractIdFor(d.passphrase, deployer.publicKey(), salt);
    // Deploying from an address needs that address's authorization, here as the transaction source.
    const createArgs = new xdr.CreateContractArgsV2({
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({ address: new Address(deployer.publicKey()).toScAddress(), salt }),
      ),
      executable: xdr.ContractExecutable.contractExecutableWasm(wasmHash),
      constructorArgs: [],
    });
    const auth = [
      sourceAccountAuth(
        new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(createArgs), subInvocations: [] }),
      ),
    ];
    await d.submit(deployer, Operation.createCustomContract({ address: new Address(deployer.publicKey()), wasmHash, salt, auth }), {
      soroban: { readOnly: [codeKey(wasmHash)], readWrite: [instanceKey(id)], instructions: 10_000_000 },
    });
    ids.push(id);
  }
  return { wasmHash, ids };
}

// ── CAP-0046: a map whose keys need host ordering and collide natively ───
// Host order: ScVal type first, then value. Integers by value, bytes, strings
// and symbols by raw bytes, addresses accounts before contracts. u32 1 and
// symbol "1" are distinct keys that print the same.
function hostOrderedMap(account, contract) {
  const keys = [
    xdr.ScVal.scvU32(1),
    xdr.ScVal.scvI32(-1),
    xdr.ScVal.scvBytes(Buffer.from([9])),
    xdr.ScVal.scvBytes(Buffer.from([10])),
    xdr.ScVal.scvString('b'),
    xdr.ScVal.scvSymbol('1'),
    xdr.ScVal.scvSymbol('aa'),
    xdr.ScVal.scvSymbol('b'),
    new Address(account).toScVal(),
    new Address(contract).toScVal(),
  ];
  return keys.map((key, i) => new xdr.ScMapEntry({ key, val: xdr.ScVal.scvU32(i) }));
}

async function scmapHostOrder(d, probe, deployer) {
  const contract = probe.ids[0];
  const entries = hostOrderedMap(deployer.publicKey(), contract);
  const key = xdr.ScVal.scvSymbol('m');
  const map = xdr.ScVal.scvMap(entries);
  const res = await d.submit(deployer, Operation.invokeContractFunction({ contract, function: 'put', args: [key, map] }), {
    soroban: { readOnly: [instanceKey(contract), codeKey(probe.wasmHash)], readWrite: [contractDataKey(contract, key)], instructions: 10_000_000 },
  });
  const entry = await d.entry(contractDataKey(contract, key));
  return writeFixture({
    id: `cap46-scmap-host-order-${d.name}-0001`,
    cap_ids: ['CAP-0046'],
    protocol_version: d.protocolVersion,
    network: d.name,
    xdr_path: 'contractData.val (an scvMap)',
    source: { ...d.source(res), ledger_entry_at: entry.lastModified, contract },
    expected_decoded: {
      contract,
      key: 'm',
      entry_count: entries.length,
      keys_xdr: entries.map((e) => e.key.toXDR('base64')),
      colliding_native_keys: [['u32 1', 'symbol "1"']],
    },
    sightings: ['stellar/js-stellar-sdk#1766', 'stellar/js-stellar-sdk#1789'],
    files: {
      ledger_entry: { xdr_type: 'LedgerEntryData', b64: entry.b64 },
      envelope: { xdr_type: 'TransactionEnvelope', b64: res.envelope },
      meta: { xdr_type: 'TransactionMeta', b64: res.meta },
    },
  });
}

// ── CAP-0046: a nested authorization tree, one level per contract ────────
async function nestedAuth(d, probe, deployer) {
  const chain = probe.ids.slice(1);
  const who = new Address(deployer.publicKey()).toScVal();
  const argsAt = (i) => [who, xdr.ScVal.scvVec(chain.slice(i + 1).map((c) => new Address(c).toScVal()))];
  const invocation = (i) =>
    new xdr.SorobanAuthorizedInvocation({ function: contractFn(chain[i], 'nest', argsAt(i)), subInvocations: i + 1 < chain.length ? [invocation(i + 1)] : [] });
  const res = await d.submit(
    deployer,
    Operation.invokeContractFunction({ contract: chain[0], function: 'nest', args: argsAt(0), auth: [sourceAccountAuth(invocation(0))] }),
    { soroban: { readOnly: [...chain.map(instanceKey), codeKey(probe.wasmHash), accountKey(deployer)], instructions: 20_000_000 } },
  );
  return writeFixture({
    id: `cap46-nested-auth-${d.name}-0001`,
    cap_ids: ['CAP-0046'],
    protocol_version: d.protocolVersion,
    network: d.name,
    xdr_path: 'tx.operations[0].body.invokeHostFunctionOp.auth[0].rootInvocation',
    source: d.source(res),
    expected_decoded: { who: deployer.publicKey(), auth_depth: chain.length, auth_invocations: chain.length, root_contract: chain[0], return_u32: chain.length },
    sightings: [],
    files: {
      envelope: { xdr_type: 'TransactionEnvelope', b64: res.envelope },
      meta: { xdr_type: 'TransactionMeta', b64: res.meta },
    },
  });
}

// ── CAP-0046 + CAP-0027: a Soroban operation from a muxed source ─────────
// stellar-core rejects a muxed source only on InvokeHostFunction (from
// protocol 25); ExtendFootprintTtl and RestoreFootprint accept one at every
// protocol. The entry extended is a Stellar Asset Contract instance deployed
// for the purpose, so the scenario needs no Wasm and runs at any protocol.
async function muxedSorobanSource(d) {
  const owner = d.keypair('cap46-muxed-owner');
  await d.fund(owner);
  const asset = new Asset('MUXD', owner.publicKey());
  const contract = asset.contractId(d.passphrase);
  await d.submit(owner, Operation.createStellarAssetContract({ asset }), {
    soroban: { readOnly: [accountKey(owner)], readWrite: [instanceKey(contract)] },
  });
  const muxedId = '7';
  const res = await d.submit(owner, Operation.extendFootprintTtl({ extendTo: 50_000 }), {
    rawMuxedSource: muxedId,
    soroban: { readOnly: [instanceKey(contract)], instructions: 1_000_000 },
  });
  return writeFixture({
    id: `cap46-muxed-soroban-source-${d.name}-0001`,
    cap_ids: ['CAP-0046', 'CAP-0027'],
    protocol_version: d.protocolVersion,
    network: d.name,
    xdr_path: 'tx.sourceAccount (muxed), tx.operations[0].body.extendFootprintTtlOp',
    source: { ...d.source(res), sac_contract: contract },
    expected_decoded: { source_account: owner.publicKey(), source_muxed_id: muxedId, operation: 'extendFootprintTtl' },
    expected_indexed: { participants: [owner.publicKey()] },
    sightings: ['stellar/wallet-backend#716'],
    files: {
      envelope: { xdr_type: 'TransactionEnvelope', b64: res.envelope },
      meta: { xdr_type: 'TransactionMeta', b64: res.meta },
    },
  });
}

/** Every scenario; `drivers` lists which network drivers can run it. */
export const SCENARIOS = [
  { name: 'signed-payload-signer', run: signedPayloadSigner, drivers: ['rpc', 'core'] },
  { name: 'sac-trust', run: sacTrust, drivers: ['rpc', 'core'] },
  { name: 'muxed-max-id', run: muxedMaxId, drivers: ['core'] },
  { name: 'pool-issuer-order', run: poolIssuerOrder, drivers: ['core'] },
  { name: 'memo-non-utf8', run: memoNonUtf8, drivers: ['core'] },
  { name: 'max-amount', run: maxAmount, drivers: ['core'] },
  { name: 'max-length-vectors', run: maxLengthVectors, drivers: ['core'] },
  { name: 'muxed-soroban-source', run: muxedSorobanSource, drivers: ['core'] },
  // The probe contract is built with soroban-sdk 29: protocol 29 and later.
  { name: 'probe', drivers: ['core'], minProtocol: 29, probe: [scmapHostOrder, nestedAuth] },
];

export async function runScenarios(d, kind) {
  const out = [];
  for (const s of SCENARIOS.filter((x) => x.drivers.includes(kind) && d.protocolVersion >= (x.minProtocol ?? 0))) {
    if (s.run) out.push(await s.run(d));
    else {
      const deployer = d.keypair('probe-deployer');
      await d.fund(deployer, '100000');
      const probe = await deployProbe(d, deployer, 7);
      for (const run of s.probe) out.push(await run(d, probe, deployer));
    }
  }
  return out;
}
