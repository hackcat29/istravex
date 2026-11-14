// Create and capture CAP-0040 and CAP-0073 cases on Stellar testnet.
// For a reproducible run on a pinned stellar-core, use kit/capture/generate.mjs.
//   node kit/capture/testnet.mjs
import { Networks } from '@stellar/stellar-sdk';
import { rpcDriver } from './drivers/rpc.mjs';
import { runScenarios } from './scenarios.mjs';

const d = await rpcDriver({
  name: 'testnet',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  friendbotUrl: 'https://friendbot.stellar.org/',
  passphrase: Networks.TESTNET,
});
await runScenarios(d, 'rpc');
