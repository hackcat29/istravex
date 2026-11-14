/**
 * Single source of truth for every word on the page.
 * Sections import from here; edit copy here, not in components.
 * Keep it terse: no taglines, eyebrows or helper text.
 */

export const RFP_URL = 'https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/rfp-track';
export const PROPOSAL_URL = '/proposal.md';

export const nav = [
  { href: '#problem', label: 'Problem' },
  { href: '#kit', label: 'Kit' },
  { href: '#anatomy', label: 'Fixture' },
  { href: '#milestones', label: 'Milestones' },
  { href: '#open-source', label: 'Open source' },
] as const;

export const hero = {
  badge: 'SCF #46 · RFP 2',
  title: ['The XDR conformance', 'and replay kit', 'for Stellar.'],
  primary: { label: 'Read the proposal', href: PROPOSAL_URL },
  secondary: { label: 'See the kit', href: '#kit' },
};

export type Verdict = 'correct' | 'incorrect' | 'dropped';
export const verdictLabel: Record<Verdict, string> = {
  correct: 'Correct',
  incorrect: 'Incorrect',
  dropped: 'Dropped',
};

/** A real uint64 muxed ID. JS `Number` cannot hold it; the page computes the loss live. */
export const MUXED_ID = '9223372036854775807';

export type Row = readonly [field: string, value: string];
export type ProblemCase = {
  id: string;
  tab: string;
  cap: string;
  ledgerTitle: string;
  indexerTitle: string;
  ledger: Row[];
  /** null → derived at runtime (see Problem.tsx) */
  indexer: Row[] | null;
  verdict: Verdict;
};

export const problem: { title: string[]; cases: ProblemCase[] } = {
  title: ['Valid on chain.', 'Wrong downstream.'],
  cases: [
    {
      id: 'muxed',
      tab: 'Muxed ID',
      cap: 'CAP-0027',
      ledgerTitle: 'Ledger',
      indexerTitle: 'Indexer',
      ledger: [
        ['destination', 'M…AAAAAAAAAH7777'],
        ['ed25519', 'GA7Q…K2XM'],
        ['id', MUXED_ID],
      ],
      // indexer rows are derived at runtime for this case
      indexer: null,
      verdict: 'incorrect',
    },
    {
      id: 'sac',
      tab: 'SAC trustline',
      cap: 'CAP-0073',
      ledgerTitle: 'Ledger',
      indexerTitle: 'Indexer',
      ledger: [
        ['op', 'invokeHostFunction'],
        ['change', 'CREATED trustline'],
        ['asset', 'USDC:GA5Z…KZVN'],
      ],
      indexer: [
        ['op', 'invokeHostFunction'],
        ['change', '—'],
        ['asset', '—'],
      ],
      verdict: 'dropped',
    },
    {
      id: 'feebump',
      tab: 'Fee-bump',
      cap: 'CAP-0015',
      ledgerTitle: 'Ledger',
      indexerTitle: 'Indexer',
      ledger: [
        ['fee charged', '200 stroops'],
        ['fee source', 'GDFE…E7QA'],
        ['inner source', 'GB3S…RC4M'],
      ],
      indexer: [
        ['fee charged', '200 stroops'],
        ['fee source', 'GB3S…RC4M'],
        ['inner source', 'GB3S…RC4M'],
      ],
      verdict: 'incorrect',
    },
  ],
};

export const kit = {
  title: ['Five parts.', 'One shared corpus.'],
  parts: [
    {
      id: 'corpus',
      n: '01',
      title: 'Corpus & CAP audit',
      body: 'Versioned XDR fixtures tied to the CAP and protocol that introduced them. Captured ledgers and pinned stellar-core recipes; anything hand-authored is marked synthetic.',
    },
    {
      id: 'replay',
      n: '02',
      title: 'Offline replay harness',
      body: 'A mock getLedgers endpoint feeds fixed sequences through your ingestion pipeline. No network, no credentials, bounded memory.',
    },
    {
      id: 'runner',
      n: '03',
      title: 'Cross-SDK runner',
      body: 'Pinned JavaScript, Go and Rust adapters decode, re-encode byte-for-byte, and exercise native conversions where precision leaks.',
    },
    {
      id: 'linter',
      n: '04',
      title: 'Go linter & guide',
      body: 'Three ingestion rules, plus a hardening guide reviewed by a Stellar Core or platform engineer.',
    },
    {
      id: 'pilot',
      n: '05',
      title: 'Upstream pilot',
      body: 'The corpus runs against wallet-backend. Every confirmed finding ships with a fixture, a CAP and an upstream issue.',
    },
  ],
};

export const lintRules = [
  { id: 'IX001', line: 3, label: 'Trusts a Core pass-through field' },
  { id: 'IX002', line: 6, label: 'Recursion with no depth limit' },
  { id: 'IX003', line: 9, label: 'Participants read from the envelope' },
] as const;

export const lintCode = [
  'func ingest(tx ingest.LedgerTransaction) error {',
  '  env := tx.Envelope',
  '  fee := tx.Result.FeeCharged',
  '  ops := env.Operations()',
  '  for _, op := range ops {',
  '    walk(op.Body, 0)',
  '  }',
  '  // who was affected?',
  '  who := env.SourceAccount()',
  '  return store(fee, who, ops)',
  '}',
];

export const sdks = ['JavaScript', 'Go', 'Rust'] as const;
export const checks = ['decode', 're-encode', 'native'] as const;

/** XDR tree for the muxed-payment fixture, rendered in 3D by the anatomy scene. */
export type XdrNode = {
  id: string;
  label: string;
  type: string;
  path: string;
  parent?: string;
  expect?: string;
};

export const anatomy = {
  title: ['Anatomy of', 'a fixture.'],
  fixtureId: 'muxed-payment-recipient-0001',
  defaultNode: 'id',
  nodes: [
    { id: 'env', label: 'TransactionEnvelope', type: 'union ENVELOPE_TYPE_TX', path: 'envelope' },
    { id: 'v1', label: 'v1', type: 'TransactionV1Envelope', path: 'envelope.v1', parent: 'env' },
    { id: 'tx', label: 'tx', type: 'Transaction', path: 'envelope.v1.tx', parent: 'v1' },
    { id: 'sigs', label: 'signatures', type: 'DecoratedSignature<20>', path: 'envelope.v1.signatures', parent: 'v1', expect: 'Count and hints re-encode unchanged.' },
    { id: 'src', label: 'sourceAccount', type: 'MuxedAccount', path: 'envelope.v1.tx.sourceAccount', parent: 'tx' },
    { id: 'fee', label: 'fee', type: 'uint32', path: 'envelope.v1.tx.fee', parent: 'tx' },
    { id: 'seq', label: 'seqNum', type: 'int64', path: 'envelope.v1.tx.seqNum', parent: 'tx', expect: 'Stored as a decimal string.' },
    { id: 'op', label: 'operations[0]', type: 'Operation', path: 'envelope.v1.tx.operations[0]', parent: 'tx' },
    { id: 'pay', label: 'paymentOp', type: 'PaymentOp', path: 'envelope.v1.tx.operations[0].body.paymentOp', parent: 'op' },
    { id: 'dest', label: 'destination', type: 'MuxedAccount', path: '….paymentOp.destination', parent: 'pay', expect: 'Arm stays KEY_TYPE_MUXED_ED25519.' },
    { id: 'amt', label: 'amount', type: 'int64', path: '….paymentOp.amount', parent: 'pay', expect: 'Full precision, no float.' },
    { id: 'asset', label: 'asset', type: 'Asset', path: '….paymentOp.asset', parent: 'pay' },
    { id: 'id', label: 'id', type: 'uint64', path: '….destination.med25519.id', parent: 'dest', expect: `Exactly ${MUXED_ID}.` },
    { id: 'key', label: 'ed25519', type: 'uint256', path: '….destination.med25519.ed25519', parent: 'dest', expect: 'Underlying G-account preserved.' },
  ] satisfies XdrNode[],
};

export const fixtures = {
  title: 'Proposed fixtures',
  items: [
    {
      id: 'signed-payload-signer',
      cap: 'CAP-0040',
      name: 'Signed-payload signer',
      expect: 'Signer type, public key and payload bytes survive decoding.',
      manifest: {
        id: 'cap40-signed-payload-signer-0001',
        cap_ids: ['CAP-0040'],
        network: 'testnet',
        xdr_type: 'LedgerEntry',
        xdr_path: 'account.signers[0].key.ed25519SignedPayload',
        source: 'stellar-core@pinned recipe',
        synthetic: false,
        expected_decoded: { type: 'SIGNER_KEY_TYPE_ED25519_SIGNED_PAYLOAD', payload_len: '32' },
      },
    },
    {
      id: 'sac-trustline',
      cap: 'CAP-0073',
      name: 'SAC trustline',
      expect: 'Trustline activity in ledger meta is indexed, even with no classic change.',
      manifest: {
        id: 'cap73-sac-trustline-0001',
        cap_ids: ['CAP-0073'],
        network: 'testnet',
        xdr_type: 'LedgerCloseMeta',
        xdr_path: 'v2.txProcessing[0].txApplyProcessing',
        source: 'captured ledger',
        synthetic: false,
        expected_indexed: { trustline: 'created', asset: 'USDC' },
      },
    },
    {
      id: 'muxed-recipient',
      cap: 'CAP-0027',
      name: 'Muxed payment recipient',
      expect: 'Underlying account and full muxed ID survive decode and indexing.',
      manifest: {
        id: 'muxed-payment-recipient-0001',
        cap_ids: ['CAP-0027'],
        network: 'testnet',
        xdr_type: 'TransactionEnvelope',
        xdr_path: 'v1.tx.operations[0].body.paymentOp.destination',
        source: 'captured ledger',
        synthetic: false,
        expected_decoded: { muxed_id: MUXED_ID },
      },
    },
  ],
};

export const milestones = {
  title: ['Three milestones.', 'Each one shippable.'],
  items: [
    {
      n: '01',
      title: 'Corpus and reference replay',
      deliver: ['Starter corpus', 'Fixture generator', 'Manifest schema', 'Reference adapter'],
      accept: 'A clean checkout validates provenance and replays the same sequence offline with stable results.',
    },
    {
      n: '02',
      title: 'Conformance and linting',
      deliver: ['JS · Go · Rust in CI', 'Per-fixture results matrix', 'Go linter, three rules'],
      accept: 'All three SDKs run the shared corpus in CI. The linter flags all three rules and passes the clean reference.',
    },
    {
      n: '03',
      title: 'Upstream pilot and release',
      deliver: ['wallet-backend findings', 'Reviewed guide', 'Tagged release', 'CI templates'],
      accept: 'Findings and upstream links are public, the guide has engineering review, and a tagged release ships.',
    },
  ],
};

export const openSource = {
  title: ['Open by default.', 'Maintained after launch.'],
  stats: [
    { value: 'Apache 2.0', label: 'License' },
    { value: '6 mo', label: 'Named maintainer' },
    { value: '1', label: 'Protocol upgrade covered' },
    { value: '0', label: 'Telemetry' },
  ],
};

export const cta = {
  title: ['Fix it once.', 'Test it everywhere.'],
  primary: { label: 'Read the proposal', href: PROPOSAL_URL },
  secondary: { label: 'RFP Track', href: RFP_URL },
};

export const footer = {
  note: 'Proposed for SCF #46. Interface previews are illustrative.',
};
