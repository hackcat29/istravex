// Types for the mock Stellar RPC (kit/rpc/server.mjs), used by the API server.
export const PASSPHRASE: Record<'pubnet' | 'testnet' | 'local', string>;
export interface LedgerStore {
  network: string;
  index: { network: string; ledger: number; path: string; sha256: string }[];
}
export function openLedgerStore(network: string, corpusDir?: string): LedgerStore;
export type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
export type JsonRpcResponse = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };
export function createHandler(store: LedgerStore): (req: JsonRpcRequest) => JsonRpcResponse;
export function startServer(opts: { network: string; port?: number; corpusDir?: string }): Promise<import('node:http').Server>;
