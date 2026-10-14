/**
 * Live portfolio + activity data for the extension popup.
 *
 * Reads balances straight from each chain's RPC (Lithosphere Mainnet, the
 * external EVM chains, custom networks, BTC/SOL/ATOM) and prices them via
 * @thanos/sdk-core's CoinGecko pricing. Activity is the wallet's own history
 * (lib/local-activity.ts): sends, settled on their own chain; native LITHO in
 * and out from the Lithosphere explorer; and funds received on every other
 * network, noticed as balance increases (lib/incoming.ts). (The Thanos
 * indexer only covers the Makalu testnet, which the wallet no longer
 * includes — 2026-09-29.)
 */
import { createContext, useContext, useEffect, useState } from 'react';
import { fetchEcosystemPrices, formatFiat } from '@thanos/sdk-core';
import { getLocalActivity, addLocalReceive, mergeExplorerRows, resolvePendingActivity, rowId } from '../../lib/local-activity';
import { fetchMainnetNativeActivity } from '../../lib/explorer-activity';
import { detectIncoming, watchKeyEvm, watchKeyNative, type WatchedBalance } from '../../lib/incoming';
import { loadSnapshot, saveSnapshot } from './portfolio-cache';

/* ─── Display helpers ────────────────────────────────────────────────── */

const COIN_COLORS: Record<string, string> = {
  LITHO: '#8b7df7', WLITHO: '#a395f8', BTC: '#f7931a', LITBTC: '#f7931a',
  ETH: '#627eea', SOL: '#14f195', USDC: '#2775ca', USDT: '#26a17b',
  BNB: '#f3ba2f', JOT: '#3b7af7', IMAGE: '#10b981', LAX: '#a3e635',
  FGPT: '#10b981', COLLE: '#a3e635', AGII: '#8b7df7',
  BLDR: '#f97316', MUSA: '#eab308',
};
export function coinColor(sym: string): string {
  return COIN_COLORS[(sym || '').toUpperCase()] ?? '#8b7df7';
}

/** Format a USD amount in the user's display currency (Settings →
 *  Currency). Conversion happens at format time via the shared sdk-core fx
 *  engine; the value pipeline stays USD. Falls back to $ until rates load. */
export function formatUsd(n: number): string {
  return formatFiat(n);
}

export function formatAmount(n: number): string {
  if (!isFinite(n) || n === 0) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 1 ? 4 : 8 });
}

function relativeTime(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const m = Math.floor((Date.now() - t) / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** The wallet's history (lib/local-activity.ts) as display rows, newest
 *  first. "Pending" only while a send hasn't been settled on its chain. */
function activityFromStore(address: string): DisplayTx[] {
  return getLocalActivity(address).map((t) => {
    const received = t.label === 'Received';
    const status = t.status ?? 'pending';
    const amt = String(t.amount).replace(/^[+-]/, '');
    return {
      id: rowId(t),
      sym: t.sym,
      label: t.label,
      amount: `${received ? '+' : '-'}${amt}`,
      time: relativeTime(new Date(t.ts).toISOString()) || 'just now',
      pos: received,
      color: coinColor(t.sym),
      ...(t.hash ? { txHash: t.hash } : {}),
      ts: new Date(t.ts).toISOString(),
      rawAmount: parseFloat(amt) || 0,
      status,
      pending: status === 'pending' ? true : undefined,
    };
  });
}

/** Funds received (lib/incoming.ts) go into the history. Native LITHO on
 *  Lithosphere Mainnet is skipped here — the explorer lists it with its hash. */
function recordIncoming(address: string, reads: WatchedBalance[]): void {
  for (const rx of detectIncoming(address, reads)) {
    if (rx.chainId === 9005 && !rx.tokenAddress) continue;
    const now = Date.now();
    addLocalReceive(address, {
      id: `recv:${rx.key}:${now}`, chain: rx.chain, sym: rx.sym, amount: formatAmount(rx.amount), ts: now,
      chainId: rx.chainId, networkName: rx.networkName, tokenAddress: rx.tokenAddress,
    });
  }
}

/* ─── Types ──────────────────────────────────────────────────────────── */

export interface DisplayCoin {
  sym: string; name: string;
  balance: number; balanceText: string; decimals: number;
  priceUsd: number; usdValue: number; color: string;
  tokenAddress?: string; native: boolean;
  /** EVM chainId for external-EVM holdings (1/56/137/…); absent for Litho/BTC/SOL/ATOM. */
  chainId?: number;
}

export interface DisplayTx {
  id: string; sym: string;
  label: 'Sent' | 'Received' | 'Swap' | 'Activity';
  amount: string; time: string; pos: boolean; color: string;
  /** Raw fields the detail modal needs (the display strings above are lossy):
   *  hash for the on-chain fee/nonce lookup, ISO timestamp for the date-time
   *  line, numeric amount for the ≈fiat hero, raw indexer status. */
  txHash?: string;
  ts?: string;
  rawAmount?: number;
  status?: string;
  /** True while this row is a local optimistic send not yet confirmed by the
   *  indexer. Drops to undefined once the indexer reports the hash and the
   *  local copy is deduped out (see mergeLocalActivity). Drives the "Pending"
   *  badge; never persisted from the indexer. */
  pending?: boolean;
}

export interface PortfolioState {
  coins:    DisplayCoin[];
  activity: DisplayTx[];
  totalUsd: number;
  loading:  boolean;
  offline:  boolean;
  reload:   () => void;
}

/** Fetch + price the wallet's portfolio and activity. When `seed` is
 *  provided, also derives BTC/SOL/ATOM addresses and adds their native
 *  balances to the displayed coin list — so the dashboard total
 *  reflects every chain. */
/** Build the initial hook state, seeded synchronously from this address's
 *  last-known snapshot so the (re)mounted popup paints real numbers instantly.
 *  loading stays true — a background refresh always runs. */
function initialStateFor(address: string): Omit<PortfolioState, 'reload'> {
  const snap = /^0x[0-9a-fA-F]{40}$/.test(address || '') ? loadSnapshot(address) : null;
  return snap
    ? { coins: snap.coins, activity: snap.activity, totalUsd: snap.totalUsd, loading: true, offline: false }
    : { coins: [], activity: [], totalUsd: 0, loading: true, offline: false };
}

export function usePortfolio(address: string, seed?: string[]): PortfolioState {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<Omit<PortfolioState, 'reload'>>(() => initialStateFor(address));

  const seedKey = seed?.join(' ') ?? '';

  useEffect(() => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) {
      setState({ coins: [], activity: [], totalUsd: 0, loading: false, offline: false });
      return;
    }
    // Address changed — hydrate from THAT address's snapshot (or empty).
    setState(initialStateFor(address));
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, offline: false }));
    (async () => {
      try {
        // Balances come straight from each chain's RPC below. The Thanos
        // indexer only covers the Makalu testnet, which the wallet no longer
        // includes (2026-09-29), so its holdings and activity aren't shown.
        // A pricing outage mustn't hide balances — they just show unpriced.
        const prices = await fetchEcosystemPrices().catch(() => ({} as Record<string, number>));
        if (cancelled) return;

        // Cross-chain native positions — only when seed is unlocked.
        const xchain: DisplayCoin[] = [];
        if (seedKey) {
          const phrase = seedKey;
          const tries = await Promise.allSettled([
            (async () => {
              const m = await import('../../lib/bitcoin');
              const addr = m.getBitcoinAddress(phrase);
              const bal = parseFloat(await m.getBitcoinBalance(addr)) || 0;
              return { sym: 'BTC',  name: 'Bitcoin',    bal, decimals: 8 };
            })(),
            (async () => {
              const m = await import('../../lib/solana');
              const addr = m.getSolanaAddress(phrase);
              const bal = parseFloat(await m.getSolanaBalance(addr)) || 0;
              return { sym: 'SOL',  name: 'Solana',     bal, decimals: 9 };
            })(),
            (async () => {
              const m = await import('../../lib/cosmos');
              const addr = await m.getCosmosAddress(phrase);
              const bal = parseFloat(await m.getCosmosBalance(addr)) || 0;
              return { sym: 'ATOM', name: 'Cosmos Hub', bal, decimals: 6 };
            })(),
          ]);
          recordIncoming(address, tries.flatMap((r) => r.status !== 'fulfilled' ? [] : [{
            key: watchKeyNative(r.value.sym), sym: r.value.sym, balance: r.value.bal, decimals: r.value.decimals,
            networkName: r.value.name, chain: (r.value.sym === 'BTC' ? 'bitcoin' : r.value.sym === 'SOL' ? 'solana' : 'cosmos') as WatchedBalance['chain'],
          }]));
          for (const r of tries) {
            if (r.status !== 'fulfilled' || r.value.bal <= 0) continue;
            const priceUsd = prices[r.value.sym] ?? 0;
            xchain.push({
              sym: r.value.sym, name: r.value.name,
              balance: r.value.bal, balanceText: formatAmount(r.value.bal),
              decimals: r.value.decimals, priceUsd, usdValue: r.value.bal * priceUsd,
              color: coinColor(r.value.sym), native: true,
            });
          }
        }

        // External EVM (Ethereum/BNB/Polygon/Base/Arbitrum/Optimism/Linea/
        // Avalanche) — native coins + USDT/USDC at the SAME 0x address. The
        // extension's host_permissions (*/*) cover these RPCs, so the popup
        // reads them directly. Read-only; best-effort per chain.
        const evmExt: DisplayCoin[] = [];
        try {
          const m = await import('../../lib/evm-external');
          const [nativeReads, tokenReads] = await Promise.all([
            m.readAllExtEvmNativeBalances(address),
            m.readAllExtEvmTokenBalances(address),
          ]);
          if (cancelled) return;
          recordIncoming(address, [
            ...nativeReads.flatMap(({ chain, balance }) => balance == null ? [] : [{
              key: watchKeyEvm(chain.chainId), sym: chain.nativeSymbol, balance, decimals: 18,
              networkName: chain.name, chain: 'evm' as const, chainId: chain.chainId,
            }]),
            ...tokenReads.flatMap(({ token, balance }) => balance == null ? [] : [{
              key: watchKeyEvm(token.chainId, token.address), sym: token.symbol, balance, decimals: token.decimals,
              networkName: m.getExtEvmChain(token.chainId)?.name ?? '', chain: 'evm' as const,
              chainId: token.chainId, tokenAddress: token.address,
            }]),
          ]);
          const natives = nativeReads.filter((r): r is { chain: typeof r.chain; balance: number } => r.balance != null && r.balance > 0);
          const tokens = tokenReads.filter((r): r is { token: typeof r.token; balance: number } => r.balance != null && r.balance > 0);
          for (const { chain, balance } of natives) {
            const priceUsd = prices[chain.nativeSymbol] ?? 0;
            evmExt.push({
              sym: chain.nativeSymbol, name: chain.name, chainId: chain.chainId,
              balance, balanceText: formatAmount(balance), decimals: 18,
              priceUsd, usdValue: balance * priceUsd, color: chain.color, native: true,
            });
          }
          for (const { token, balance } of tokens) {
            // Built-in USDT/USDC are ≈$1; custom tokens use a live price if known,
            // else $0 — never fabricate a stablecoin peg for an unknown token.
            const isStable = token.symbol === 'USDT' || token.symbol === 'USDC';
            const priceUsd = prices[token.symbol] ?? (isStable ? 1 : 0);
            evmExt.push({
              sym: token.symbol, name: `${token.symbol} · ${m.getExtEvmChain(token.chainId)?.name ?? ''}`.trim(),
              chainId: token.chainId, balance, balanceText: formatAmount(balance),
              decimals: token.decimals, priceUsd, usdValue: balance * priceUsd,
              color: token.symbol === 'USDT' ? '#26a17b' : token.symbol === 'USDC' ? '#2775ca' : coinColor(token.symbol),
              tokenAddress: token.address, native: false,
            });
          }
        } catch { /* best-effort */ }

        const totalUsd = xchain.reduce((s, x) => s + x.usdValue, 0)
                       + evmExt.reduce((s, x) => s + x.usdValue, 0);
        const coins: DisplayCoin[] = [...xchain, ...evmExt];
        // Lithosphere MAINNET (chainId 9005) always leads regardless of
        // amount — the Web4 home chain, client requirement 2026-08-27.
        coins.sort((a, b) => {
          const rank = (c: typeof a) => c.chainId === 9005 ? -1 : c.sym === 'LITHO' ? 0 : 1;
          return rank(a) - rank(b);
        });

        const mergedActivity = activityFromStore(address);
        setState({ coins, activity: mergedActivity, totalUsd, loading: false, offline: false });
        // Then bring the history up to date without holding up the balances:
        // Lithosphere explorer rows (receives, sends from other devices) and
        // pending sends settled on their own chain.
        void (async () => {
          const explorer = await fetchMainnetNativeActivity(address).catch(() => null);
          if (explorer) mergeExplorerRows(address, explorer);
          await resolvePendingActivity(address).catch(() => null);
          if (cancelled) return;
          const activity = activityFromStore(address);
          setState((st) => ({ ...st, activity }));
          if (coins.length > 0) saveSnapshot(address, { coins, activity, totalUsd });
        })();
        // Persist the fresh result so the next popup open paints instantly.
        // Guard on coins.length: the per-chain reads are best-effort, so an
        // RPC outage can reach here as an empty list with offline:false —
        // without this guard it would overwrite a good snapshot and defeat
        // cached-first on the next open. A genuinely-empty wallet simply isn't
        // cached (it just shows a brief skeleton next time), which is fine.
        if (coins.length > 0) {
          saveSnapshot(address, { coins, activity: mergedActivity, totalUsd });
        }
      } catch {
        if (cancelled) return;
        // Pricing unreachable — still surface the user's own recorded sends.
        setState({ coins: [], activity: activityFromStore(address), totalUsd: 0, loading: false, offline: true });
      }
    })();
    return () => { cancelled = true; };
  }, [address, nonce, seedKey]);

  return { ...state, reload: () => setNonce((n) => n + 1) };
}

/* ─── Context — App fetches once, every screen reads it ──────────────── */

export const PortfolioContext = createContext<PortfolioState>({
  coins: [], activity: [], totalUsd: 0, loading: false, offline: false, reload: () => {},
});
export function usePortfolioCtx(): PortfolioState {
  return useContext(PortfolioContext);
}
