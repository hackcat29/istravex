// Create and capture CAP-0040 and CAP-0073 cases on Stellar testnet.
// These patterns are hard to find on mainnet, so we produce them on a real
// network and capture what the ledger recorded. Funded by friendbot.
// For a reproducible run on a pinned stellar-core, use kit/capture/generate.mjs.
//   node kit/capture/testnet.mjs
import { Networks } from '@stellar/stellar-sdk';
import { runScenarios } from './scenarios.mjs';

await runScenarios({
  name: 'testnet',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  friendbotUrl: 'https://friendbot.stellar.org/',
  passphrase: Networks.TESTNET,
  source: { kind: 'captured' },
});
