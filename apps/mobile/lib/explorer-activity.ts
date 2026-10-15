/**
 * Activity rows from the block explorers (lib/chain-history.ts) and the
 * history Activity keeps on the device.
 *
 * Activity used to read only native LITHO from LithoScan; everything else
 * came from what this device sent. The client asked for every previous
 * transaction (2026-10-15), so the activity hook now reads each network's
 * explorer for the wallet's addresses. A full read is a few dozen requests,
 * so it runs at most every FULL_HISTORY_EVERY_MS per address; refreshes in
 * between read Lithosphere only (as before).
 *
 * Rows are mapped into the IndexerActivityItem shape so the Activity screen
 * renders them through the same row code.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchLithoNativeHash, type HistoryRow } from './chain-history';
import type { IndexerActivityItem } from './indexer';
import { setLocalNativeHash, type LocalActivityItem } from './local-activity';
import { getActivitySnapshot, setActivitySnapshot } from './portfolio-cache';

/** An explorer row as Activity shows it: the network it's on, the token
 *  contract for a token transfer, and a Lithosphere transaction's native
 *  hash. */
export type HistoryActivityItem = IndexerActivityItem & Partial<Pick<LocalActivityItem, 'chain' | 'networkName' | 'tokenAddress' | 'nativeHash'>>;

function isoOf(ms: number): string | undefined {
  const d = new Date(ms);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** One explorer row as an Activity row. EVM rows are named by chain id (like
 *  the wallet's own sends); BTC / SOL / ATOM have none, so they carry the
 *  network name. Only known fields are set — the activity hook spreads the
 *  row over what a send recorded here, and an undefined would blank it. */
export function historyActivityItem(r: HistoryRow): HistoryActivityItem {
  const receive = r.direction === 'in';
  return {
    id:     r.id,
    type:   receive ? 'receive' : 'send',
    symbol: r.sym,
    amount: r.amount,
    txHash: r.hash,
    ts:     isoOf(r.ts),
    status: r.status,
    title:  `${receive ? 'Received' : 'Sent'} ${r.sym}`,
    chain:  r.chain,
    ...(r.chainId != null ? { chainId: r.chainId } : { networkName: r.networkName }),
    ...(r.counterparty ? { counterparty: r.counterparty } : {}),
    ...(r.tokenAddress ? { tokenAddress: r.tokenAddress } : {}),
    ...(r.blockNumber != null ? { blockNumber: r.blockNumber } : {}),
    ...(r.nativeHash ? { nativeHash: r.nativeHash } : {}),
  };
}

/** Activity history kept on the device: the latest read added to what was
 *  saved before, so a transaction past the explorers' latest page stays in
 *  Activity. Fresh rows replace every saved row of their transaction — a
 *  status that has settled, and rows saved under the older one-row-per-hash
 *  ids ("mainnet:<hash>"); a swap's legs share a hash, so rows are otherwise
 *  kept per id. A native hash saved on a row (saveNativeHash) stays on a
 *  fresh row that doesn't carry one. Newest first, at most `max` rows. */
export function accumulateActivity<T extends IndexerActivityItem & { nativeHash?: string }>(saved: T[], fresh: T[], max = 500): T[] {
  const hashOf = (i: T) => (i.txHash ? i.txHash.toLowerCase() : '');
  const freshHashes = new Set(fresh.map(hashOf).filter(Boolean));
  const nativeOf = new Map<string, string>();
  for (const i of saved) if (i.nativeHash && hashOf(i)) nativeOf.set(hashOf(i), i.nativeHash);
  const byId = new Map<string, T>();
  for (const i of saved) if (!freshHashes.has(hashOf(i))) byId.set(i.id || hashOf(i), i);
  for (const i of fresh) {
    const native = i.nativeHash ? undefined : nativeOf.get(hashOf(i));
    byId.set(i.id || hashOf(i), native ? { ...i, nativeHash: native } : i);
  }
  return [...byId.values()]
    .sort((a, b) => (b.ts ? Date.parse(b.ts) : 0) - (a.ts ? Date.parse(a.ts) : 0))
    .slice(0, max);
}

/** Put a Lithosphere transaction's native hash on every saved row of it —
 *  the history and the send recorded on this device — by its 0x hash. */
export async function saveNativeHash(address: string, evmHash: string, nativeHash: string): Promise<void> {
  const h = evmHash.toLowerCase();
  const snap = await getActivitySnapshot(address);
  const items = (snap?.items ?? []) as HistoryActivityItem[];
  if (items.some((i) => i.txHash?.toLowerCase() === h && i.nativeHash !== nativeHash)) {
    await setActivitySnapshot(address, items.map((i) => (i.txHash?.toLowerCase() === h ? { ...i, nativeHash } : i)));
  }
  await setLocalNativeHash(address, evmHash, nativeHash);
}

/** The native hash of a Lithosphere transaction Activity knows only by its 0x
 *  hash — a send made on this device, or a row saved before explorer rows
 *  carried it. Looked up on LithoScan when its detail opens and saved on its
 *  rows, so it's looked up once; null until LithoScan has indexed it. */
export async function lookupNativeHash(address: string, evmHash: string): Promise<string | null> {
  const native = await fetchLithoNativeHash(evmHash);
  if (native && address) await saveNativeHash(address, evmHash, native).catch(() => { /* best-effort */ });
  return native;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Receives this device noticed from a balance increase (lib/incoming.ts, no
 *  hash) that an explorer row now lists with its hash — same network and
 *  token, the same amount as Activity displayed it, within a day — are left
 *  out so the receive isn't listed twice. Each explorer row stands in for at
 *  most one. */
export function dropMatchedReceives<T extends LocalActivityItem>(local: T[], feed: HistoryActivityItem[]): T[] {
  const used = new Set<string>();
  return local.filter((l) => {
    if (l.type !== 'receive' || l.txHash) return true;
    const amount = parseFloat(String(l.amount).replace(/,/g, ''));
    if (!Number.isFinite(amount)) return true;
    // The noticed amount was shown to 4 decimals (8 below 1).
    const tolerance = Math.max(amount >= 1 ? 1e-4 : 1e-8, amount * 1e-6);
    const match = feed.find((x) => !used.has(x.id) && x.type === 'receive' && !!x.txHash
      && x.symbol === l.symbol
      && (l.chainId != null ? x.chainId === l.chainId : !!l.chain && x.chain === l.chain)
      && Math.abs(parseFloat(x.amount) - amount) <= tolerance
      && Math.abs((x.ts ? Date.parse(x.ts) : NaN) - l.tsMs) <= DAY_MS);
    if (!match) return true;
    used.add(match.id);
    return false;
  });
}

/* ─── Full-read throttle ─────────────────────────────────────────────── */

const FULL_SYNC_PREFIX = 'history_full_sync:';
export const FULL_HISTORY_EVERY_MS = 5 * 60 * 1000;
/** Mirrors storage, so two screens loading at once can't both claim a read. */
const lastFull = new Map<string, number>();

/** Whether a full history read is due for `address`; when it is, it's
 *  claimed (recorded now). */
export async function claimFullHistorySync(address: string): Promise<boolean> {
  const key = address.toLowerCase();
  const now = Date.now();
  const recent = (t?: number) => t != null && t <= now && now - t < FULL_HISTORY_EVERY_MS;
  if (recent(lastFull.get(key))) return false;
  let stored: number | undefined;
  try {
    const raw = await AsyncStorage.getItem(FULL_SYNC_PREFIX + key);
    if (raw) stored = Number(raw);
  } catch { /* unreadable — treat as due */ }
  // Re-checked: another screen may have claimed it while storage was read.
  if (recent(lastFull.get(key))) return false;
  if (recent(stored)) { lastFull.set(key, stored!); return false; }
  lastFull.set(key, now);
  try { await AsyncStorage.setItem(FULL_SYNC_PREFIX + key, String(now)); } catch { /* best-effort */ }
  return true;
}

/** Make the next refresh a full read — after one that couldn't reach the
 *  network, or when funds have just arrived on a network the history covers. */
export async function resetFullHistorySync(address: string): Promise<void> {
  const key = address.toLowerCase();
  lastFull.delete(key);
  try { await AsyncStorage.removeItem(FULL_SYNC_PREFIX + key); } catch { /* best-effort */ }
}
