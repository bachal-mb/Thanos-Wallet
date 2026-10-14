/**
 * Funds received, noticed in the extension — same approach as the mobile app
 * (apps/mobile/lib/incoming.ts).
 *
 * Only native LITHO on Lithosphere Mainnet has a feed (the explorer). For
 * every other asset, each balance the portfolio actually READS is compared
 * with the last one seen for it on this address; an increase is funds
 * received and goes into Activity. Failed reads are never passed in (they're
 * null, not 0), so an outage followed by recovery isn't mistaken for a
 * deposit. The first time an asset is seen its balance is just recorded —
 * existing holdings never show up as "Received".
 */
export interface WatchedBalance {
  key:           string;
  sym:           string;
  balance:       number;
  decimals:      number;
  networkName:   string;
  chain:         'evm' | 'bitcoin' | 'solana' | 'cosmos';
  chainId?:      number;
  tokenAddress?: string;
}
export interface Incoming extends WatchedBalance { amount: number }

const PREFIX = 'thanos-balance-watch:';

export const watchKeyEvm = (chainId: number, tokenAddress?: string) =>
  `evm:${chainId}:${tokenAddress ? tokenAddress.toLowerCase() : 'native'}`;
export const watchKeyNative = (sym: string) => `native:${sym}`;

/** Compare fresh reads with the last balances seen for `address`; returns
 *  the increases and remembers the new balances. Synchronous (localStorage). */
export function detectIncoming(address: string, reads: WatchedBalance[]): Incoming[] {
  if (!address || reads.length === 0 || typeof localStorage === 'undefined') return [];
  const storeKey = PREFIX + address.toLowerCase();
  let prev: Record<string, number> = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(storeKey) || '{}');
    if (parsed && typeof parsed === 'object') prev = parsed as Record<string, number>;
  } catch { /* unreadable — start fresh */ }
  const next: Record<string, number> = { ...prev };
  const out: Incoming[] = [];
  for (const r of reads) {
    if (!Number.isFinite(r.balance) || r.balance < 0) continue;
    const before = prev[r.key];
    next[r.key] = r.balance;
    if (typeof before !== 'number') continue; // first sighting: just record
    const diff = r.balance - before;
    const eps = Math.max(10 ** -Math.min(r.decimals, 12), Math.abs(before) * 1e-9);
    if (diff > eps) out.push({ ...r, amount: diff });
  }
  try { localStorage.setItem(storeKey, JSON.stringify(next)); } catch { /* best-effort */ }
  return out;
}
