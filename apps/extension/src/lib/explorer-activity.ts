/**
 * The wallet's full history from each network's block explorer — extension.
 *
 * sdk-core's fetchChainHistory reads LithoScan (Lithosphere), Blockscout
 * (Ethereum, Base, Arbitrum, Polygon, Optimism), Routescan (Avalanche),
 * mempool.space (Bitcoin), the Solana RPC and the Cosmos REST API; BNB Chain
 * and Linea need an Etherscan key (VITE_ETHERSCAN_API_KEY at build time).
 * Rows come back in the local-activity shape and are saved there
 * (mergeExplorerRows), which keeps them after they leave an explorer's latest
 * page and settles a matching pending send.
 *
 * Every popup open reads Lithosphere (one cheap request); the full read of
 * every network runs at most every FULL_SYNC_MS per wallet.
 */
import { fetchChainHistory, historyEvmChainIds, type HistoryAddresses, type HistoryRow } from '@thanos/sdk-core';
import type { LocalTx } from './local-activity';

const FULL_SYNC_MS = 5 * 60 * 1000;
const syncKey = (addr: string) => `thanos-history-sync:${addr.toLowerCase()}`;

const ETHERSCAN_KEY =
  (import.meta as unknown as { env?: { VITE_ETHERSCAN_API_KEY?: string } }).env?.VITE_ETHERSCAN_API_KEY || undefined;

/** EVM networks the explorers cover — receives anywhere else are still
 *  noticed from balance increases (lib/incoming.ts). */
export const HISTORY_EVM_CHAIN_IDS: ReadonlySet<number> = new Set(historyEvmChainIds(ETHERSCAN_KEY));

function toLocal(r: HistoryRow): LocalTx {
  return {
    hash: r.hash, id: r.id, chain: r.chain, sym: r.sym,
    label: r.direction === 'in' ? 'Received' : 'Sent',
    amount: r.amount, ts: r.ts, status: r.status,
    ...(r.chainId != null ? { chainId: r.chainId } : {}),
    networkName: r.networkName,
    ...(r.tokenAddress ? { tokenAddress: r.tokenAddress } : {}),
  };
}

/** This wallet's transfers from the explorers, or null when none could be
 *  reached. `knownHashes` are already saved (Solana skips looking them up). */
export async function fetchWalletHistory(addrs: HistoryAddresses & { evm: string }, knownHashes: string[]): Promise<LocalTx[] | null> {
  let last = 0;
  try { last = Number(localStorage.getItem(syncKey(addrs.evm))) || 0; } catch { /* storage off */ }
  const full = Date.now() - last >= FULL_SYNC_MS;
  const { rows, failed } = await fetchChainHistory(addrs, {
    sources: full ? 'all' : 'lithosphere',
    lithoPages: full ? 5 : 1,
    knownHashes,
    etherscanKey: ETHERSCAN_KEY,
  });
  // Recorded even when a source failed: one unreachable explorer mustn't
  // make every popup open re-read all of them. It's retried next window.
  if (full) { try { localStorage.setItem(syncKey(addrs.evm), String(Date.now())); } catch { /* storage off */ } }
  if (rows.length === 0 && failed.length > 0) return null;
  return rows.map(toLocal);
}
