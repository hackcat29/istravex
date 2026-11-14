/**
 * Single source of truth for every word on the page.
 * Sections import from here; edit copy here, not in components.
 * Keep it terse: no taglines, eyebrows or helper text.
 *
 * Every number and XDR value comes from src/data/corpus.json, which
 * `npm run corpus:run` regenerates from corpus/ and the SDK runners.
 */
import corpus from './data/corpus.json';

export { corpus };
export const REPO_URL = 'https://github.com/hackcat29/istravex';
export const DOCS_URL = 'https://docs.istravex.com';

type Fixture = (typeof corpus.fixtures)[number];
type ReplayRow = (typeof corpus.replay)[number];
// Prefer public-network fixtures for the page's examples: they link to an explorer.
const networkRank = { pubnet: 0, testnet: 1, local: 2 } as Record<string, number>;
const byCap = (cap: string) =>
  corpus.fixtures.filter((f) => f.cap === cap).sort((a, b) => networkRank[a.network] - networkRank[b.network])[0] as Fixture;
const replayOf = (cap: string, indexer: 'naive' | 'reference') =>
  corpus.replay.find((r) => r.cap === cap && r.indexer === indexer && r.fixture === byCap(cap).id) as ReplayRow;
const obs = (r: ReplayRow) => (r.observed ?? {}) as unknown as Record<string, string | boolean | null>;
const exp = (f: Fixture) => f.manifest.expected_decoded as unknown as Record<string, string>;

/** G…/M…/P… addresses shortened for tables; numbers are never shortened. */
export const short = (s: string) => (s.length > 14 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
export const grouped = (s: string) => BigInt(s).toLocaleString('en-US');
/** Explorer link for a public-network transaction; generated (local) fixtures have none. */
export const explorerTx = (f: { network: string; tx_hash: string }) =>
  f.network === 'local' ? '' : `https://stellar.expert/explorer/${f.network === 'pubnet' ? 'public' : 'testnet'}/tx/${f.tx_hash}`;

export const RFP_URL = 'https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/rfp-track';
export const PROPOSAL_URL = '/proposal.md';

export const QUICKSTART_URL = `${DOCS_URL}/quickstart`;

/** Top navigation: where people go next, not a table of contents for this page. */
export const nav = [
  { href: DOCS_URL, label: 'Docs' },
  { href: `${DOCS_URL}/guide/overview`, label: 'Hardening guide' },
  { href: `${DOCS_URL}/api-reference/introduction`, label: 'API' },
  { href: PROPOSAL_URL, label: 'Proposal' },
] as const;
export const navCta = { label: 'Get started', href: QUICKSTART_URL };

export const hero = {
  badge: 'SCF #46 · RFP 2',
  title: ['The XDR conformance', 'and replay kit', 'for Stellar.'],
  primary: { label: 'Get started', href: QUICKSTART_URL },
  secondary: { label: 'Read the proposal', href: PROPOSAL_URL },
};

const st = corpus.stats;
const protocols = [...new Set(corpus.fixtures.map((f) => f.protocol_version))].sort();
export const heroStats = [
  { value: String(st.fixtures), label: 'Fixtures' },
  { value: `${st.sdk_checks_passed}/${st.sdk_checks}`, label: 'SDK checks' },
  { value: `${st.provenance_passed}/${st.provenance_checks}`, label: 'Ledger-verified' },
  { value: `${st.pilot_correct}/${st.pilot_fixtures}`, label: 'wallet-backend pilot' },
];
export const protocolRange = protocols.join('–');

/** Verdicts the hero stream cycles through: every real replay and pilot result. */
export const heroVerdicts = [
  ...corpus.replay.map((r) => r.verdict),
  ...corpus.pilot.results.map((r) => r.verdict),
] as Verdict[];

export type Verdict = 'correct' | 'incorrect' | 'dropped';
export const verdictLabel: Record<Verdict, string> = {
  correct: 'Correct',
  incorrect: 'Incorrect',
  dropped: 'Dropped',
};

const f27 = byCap('CAP-0027');
const f15 = byCap('CAP-0015');
const f73 = byCap('CAP-0073');
const n27 = obs(replayOf('CAP-0027', 'naive'));
const n15 = obs(replayOf('CAP-0015', 'naive'));
const r15 = obs(replayOf('CAP-0015', 'reference'));
const x15 = exp(f15);
const i73 = f73.manifest.expected_indexed as unknown as Record<string, string>;

/** A real uint64 muxed ID from mainnet ledger 65,474,279. */
export const MUXED_ID = exp(f27).muxed_id;

export type Row = readonly [field: string, value: string];
export type ProblemCase = {
  id: string;
  tab: string;
  cap: string;
  ledger: number;
  href: string;
  ledgerTitle: string;
  indexerTitle: string;
  ledger_rows: Row[];
  indexer_rows: Row[];
  verdict: Verdict;
};

const verdictOf = (cap: string) => replayOf(cap, 'naive').verdict as Verdict;

export const problem: { title: string[]; cases: ProblemCase[] } = {
  title: ['Valid on chain.', 'Wrong downstream.'],
  cases: [
    {
      id: 'muxed',
      tab: 'Muxed ID',
      cap: f27.cap,
      ledger: f27.ledger,
      href: explorerTx(f27),
      ledgerTitle: 'Ledger',
      indexerTitle: 'Indexer',
      ledger_rows: [
        ['destination', short(exp(f27).destination_muxed)],
        ['account', short(exp(f27).destination_account)],
        ['muxed id', exp(f27).muxed_id],
      ],
      indexer_rows: [
        ['destination', short(exp(f27).destination_muxed)],
        ['account', short(String(n27.recipient))],
        ['muxed id', String(n27.recipient_muxed_id)],
      ],
      verdict: verdictOf('CAP-0027'),
    },
    {
      id: 'sac',
      tab: 'SAC trustline',
      cap: f73.cap,
      ledger: f73.ledger,
      href: explorerTx(f73),
      ledgerTitle: 'Ledger',
      indexerTitle: 'Indexer',
      ledger_rows: [
        ['call', `trust(${short(i73.account)})`],
        ['change', 'trustline created'],
        ['asset', `ISTX:${short(i73.asset.split(':')[1])}`],
      ],
      indexer_rows: [
        ['call', `trust(${short(i73.account)})`],
        ['change', '—'],
        ['asset', '—'],
      ],
      verdict: verdictOf('CAP-0073'),
    },
    {
      id: 'feebump',
      tab: 'Fee-bump',
      cap: f15.cap,
      ledger: f15.ledger,
      href: explorerTx(f15),
      ledgerTitle: 'Ledger',
      indexerTitle: 'Indexer',
      ledger_rows: [
        ['fee charged', grouped(String(r15.fee_charged))],
        ['paid by', short(x15.fee_source)],
        ['inner source', short(x15.inner_source)],
      ],
      indexer_rows: [
        ['fee charged', grouped(String(n15.fee_charged))],
        ['paid by', short(String(n15.fee_paid_by))],
        ['inner source', short(x15.inner_source)],
      ],
      verdict: verdictOf('CAP-0015'),
    },
  ],
};

const pilot = corpus.pilot;
export const pilotRef = pilot.ref.slice(0, 7);

export const kit = {
  title: ['Five parts.', 'One shared corpus.'],
  parts: [
    {
      id: 'corpus',
      docs: `${DOCS_URL}/corpus/overview`,
      n: '01',
      title: 'Corpus & CAP audit',
      body: `${st.fixtures} fixtures, each tied to its CAP and verified byte-for-byte against the ledger that closed it. ${st.covered_xdr_caps} of ${st.xdr_caps} XDR-changing CAPs covered so far.`,
    },
    {
      id: 'replay',
      docs: `${DOCS_URL}/tools/mock-rpc`,
      n: '02',
      title: 'Offline replay harness',
      body: 'A mock getLedgers RPC serves the corpus to any indexer. No network, no credentials, bounded memory.',
    },
    {
      id: 'runner',
      docs: `${DOCS_URL}/tools/sdk-runners`,
      n: '03',
      title: 'Cross-SDK runner',
      body: 'Pinned JavaScript, Go and Rust adapters decode, re-encode byte-for-byte, and exercise native conversions where precision leaks.',
    },
    {
      id: 'linter',
      docs: `${DOCS_URL}/tools/lint`,
      n: '04',
      title: 'Go linter & guide',
      body: 'Three go/analysis rules, calibrated on wallet-backend, and a hardening guide reviewed by a Stellar Core engineer.',
    },
    {
      id: 'pilot',
      docs: `${DOCS_URL}/pilots/wallet-backend`,
      n: '05',
      title: 'Upstream pilot',
      body: `wallet-backend's own ingestion, fed by the mock RPC: ${st.pilot_correct} of ${st.pilot_fixtures} fixtures indexed correctly.`,
    },
  ],
};

export const lintRules = [
  { id: 'IX001', label: 'Memo text not UTF-8 validated' },
  { id: 'IX002', label: 'Recursion with no depth limit' },
  { id: 'IX003', label: 'Fee data from the envelope' },
] as const;
export const lintFindings = pilot.lint.findings;


/** XDR tree of the real muxed-payment fixture, rendered in 3D by the anatomy scene. */
export type XdrNode = {
  id: string;
  label: string;
  type: string;
  path: string;
  parent?: string;
  value?: string;
  expect?: string;
};

const av = corpus.anatomy.values;
const usdc = (stroops: string) => `${(BigInt(stroops) / 10_000_000n).toString()}.${(BigInt(stroops) % 10_000_000n).toString().padStart(7, '0')}`;

export const anatomy = {
  title: ['Anatomy of', 'a fixture.'],
  fixtureId: corpus.anatomy.fixture,
  ledger: corpus.anatomy.ledger,
  href: explorerTx({ network: 'pubnet', tx_hash: corpus.anatomy.tx_hash }),
  defaultNode: 'id',
  nodes: [
    { id: 'env', label: 'TransactionEnvelope', type: 'ENVELOPE_TYPE_TX_FEE_BUMP', path: 'envelope' },
    { id: 'fb', label: 'feeBump', type: 'FeeBumpTransactionEnvelope', path: 'feeBump', parent: 'env' },
    { id: 'fbtx', label: 'tx', type: 'FeeBumpTransaction', path: 'feeBump.tx', parent: 'fb' },
    { id: 'sigs', label: 'signatures', type: 'DecoratedSignature<20>', path: 'feeBump.signatures', parent: 'fb', value: `${av.signatures} signature` },
    { id: 'fsrc', label: 'feeSource', type: 'MuxedAccount', path: 'feeBump.tx.feeSource', parent: 'fbtx', value: av.feeSource, expect: 'Pays the fee — not the inner source.' },
    { id: 'ofee', label: 'fee', type: 'int64', path: 'feeBump.tx.fee', parent: 'fbtx', value: av.outerFee, expect: 'A bid. The charge is in the result.' },
    { id: 'inner', label: 'innerTx', type: 'TransactionV1Envelope', path: 'feeBump.tx.innerTx.v1', parent: 'fbtx' },
    { id: 'tx', label: 'tx', type: 'Transaction', path: '….innerTx.v1.tx', parent: 'inner' },
    { id: 'src', label: 'sourceAccount', type: 'MuxedAccount', path: '….tx.sourceAccount', parent: 'tx', value: av.source },
    { id: 'fee', label: 'fee', type: 'uint32', path: '….tx.fee', parent: 'tx', value: av.fee },
    { id: 'seq', label: 'seqNum', type: 'int64', path: '….tx.seqNum', parent: 'tx', value: av.seqNum, expect: 'Above 2^53. Stored as a decimal string.' },
    { id: 'op', label: 'operations[0]', type: 'Operation', path: '….tx.operations[0]', parent: 'tx' },
    { id: 'pay', label: 'paymentOp', type: 'PaymentOp', path: '….operations[0].body.paymentOp', parent: 'op' },
    { id: 'dest', label: 'destination', type: 'MuxedAccount', path: '….paymentOp.destination', parent: 'pay', value: av.destination, expect: 'Arm stays KEY_TYPE_MUXED_ED25519.' },
    { id: 'id', label: 'id', type: 'uint64', path: '….destination.med25519.id', parent: 'dest', value: av.id, expect: `Number() reads ${String(Number(av.id))}.` },
    { id: 'key', label: 'ed25519', type: 'uint256', path: '….destination.med25519.ed25519', parent: 'dest', value: av.ed25519 },
    { id: 'asset', label: 'asset', type: 'Asset', path: '….paymentOp.asset', parent: 'pay', value: av.asset },
    { id: 'amt', label: 'amount', type: 'int64', path: '….paymentOp.amount', parent: 'pay', value: av.amount, expect: `${usdc(av.amount)} USDC. No floats.` },
  ] satisfies XdrNode[],
};

const fixtureCopy: Record<string, { name: string; expect: string }> = {
  'CAP-0027': { name: 'Muxed payment recipient', expect: 'Underlying account and full 64-bit muxed ID survive decode and indexing.' },
  'CAP-0015': { name: 'Fee-bump fee source', expect: 'Fee is attributed to the fee source, at the amount in the result.' },
  'CAP-0040': { name: 'Signed-payload signer', expect: 'Signer type, public key and payload bytes survive decoding.' },
  'CAP-0073': { name: 'SAC trustline', expect: 'A trustline created by trust() is indexed with no changeTrust op.' },
};

export const fixtures = {
  title: 'Fixtures',
  items: corpus.fixtures.map((f) => {
    const g = (f.manifest.source as { generator?: { core_version: string; binary_sha256: string } }).generator;
    return { ...f, ...fixtureCopy[f.cap], href: explorerTx(f), generator: g ? `stellar-core ${g.core_version} · ${g.binary_sha256.slice(0, 12)}` : '' };
  }),
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
  primary: { label: 'Get started', href: QUICKSTART_URL },
  secondary: { label: 'View on GitHub', href: REPO_URL },
};

export const docs = [
  { href: DOCS_URL, label: 'Docs' },
  { href: `${DOCS_URL}/guide/overview`, label: 'Hardening guide' },
  { href: `${DOCS_URL}/corpus/cap-coverage`, label: 'CAP coverage' },
  { href: `${DOCS_URL}/api-reference/introduction`, label: 'API' },
];

export const footer = {
  note: 'Every number here comes from the corpus and kit in the repository.',
};
