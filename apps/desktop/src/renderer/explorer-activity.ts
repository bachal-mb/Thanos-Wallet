/**
 * The wallet's full history from each network's block explorer — desktop.
 *
 * Until 2026-10-15 Activity only knew native LITHO on Lithosphere Mainnet
 * (LithoScan) plus the sends made on this device; the client asked for every
 * previous transaction, including ones made before Thanos or from another
 * wallet. sdk-core's fetchChainHistory reads LithoScan (Lithosphere),
 * Blockscout (Ethereum, Base, Arbitrum, Polygon, Optimism), Routescan
 * (Avalanche), mempool.space (Bitcoin), the Solana RPC and the Cosmos REST
 * API; BNB Chain and Linea need an Etherscan key (VITE_ETHERSCAN_API_KEY at
 * build time). The rows are saved with the sends (local-activity.ts
 * mergeHistoryRows), which keeps them after they leave an explorer's latest
 * page and settles a matching pending send.
 *
 * Every portfolio load reads Lithosphere (one cheap request, as before); the
 * full read of every network runs at most every FULL_SYNC_MS per wallet.
 */
import { fetchChainHistory, type HistoryAddresses, type HistoryRow } from '@thanos/sdk-core';
import { allEvmTokens } from './custom-assets';
import { getLocalActivity, mergeHistoryRows, type LocalTx } from './local-activity';

const FULL_SYNC_MS = 5 * 60 * 1000;
const syncKey = (addr: string) => `thanos-history-sync:${addr.toLowerCase()}`;

const ETHERSCAN_KEY = import.meta.env.VITE_ETHERSCAN_API_KEY || undefined;

function toLocal(r: HistoryRow): LocalTx {
  return {
    hash: r.hash, id: r.id, chain: r.chain, sym: r.sym,
    amount: r.amount, ts: r.ts, status: r.status, direction: r.direction,
    networkName: r.networkName,
    ...(r.chainId != null ? { chainId: r.chainId } : {}),
    ...(r.counterparty ? { counterparty: r.counterparty } : {}),
    ...(r.tokenAddress ? { tokenAddress: r.tokenAddress } : {}),
    // Lithosphere: LithoScan's own hash, shown before the 0x one.
    ...(r.nativeHash ? { nativeHash: r.nativeHash } : {}),
  };
}

/** Read this wallet's transfers from the explorers and save them with its
 *  sends. Returns true when the saved list changed. */
export async function syncWalletHistory(addrs: HistoryAddresses & { evm: string }): Promise<boolean> {
  let last = 0;
  try { last = Number(localStorage.getItem(syncKey(addrs.evm))) || 0; } catch { /* storage off */ }
  const full = Date.now() - last >= FULL_SYNC_MS;
  // Stamped up front, so a reload mid-read doesn't start a second full read.
  // One unreachable explorer is simply retried in the next window.
  if (full) { try { localStorage.setItem(syncKey(addrs.evm), String(Date.now())); } catch { /* storage off */ } }
  const { rows } = await fetchChainHistory(addrs, {
    sources: full ? 'all' : 'lithosphere',
    lithoPages: full ? 5 : 1,
    knownHashes: getLocalActivity(addrs.evm).map((t) => t.hash),
    knownTokens: allEvmTokens().map((t) => ({ chainId: t.chainId, address: t.address })),
    etherscanKey: ETHERSCAN_KEY,
  });
  return mergeHistoryRows(addrs.evm, rows.map(toLocal));
}
