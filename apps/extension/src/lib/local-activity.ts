/**
 * The wallet's activity history (extension), kept in localStorage per EVM
 * address.
 *
 * Nothing else reports most of a user's transactions — the Thanos indexer
 * only covers the Makalu testnet, which the wallet no longer includes — so
 * this store IS the Activity feed:
 *   - every send, recorded at broadcast with the chain it went out on;
 *   - the wallet's full history on every network, from each network's
 *     explorer (lib/explorer-activity.ts — client 2026-10-15: "all previous
 *     transactions"), saved here so it stays after leaving an explorer's
 *     latest page;
 *   - funds received on a network no explorer covers, noticed as a balance
 *     increase (lib/incoming.ts).
 *
 * History is kept (client 2026-10-14: sends "still pending" a day later, and
 * earlier "keep the history of txn") — rows are no longer dropped after 24h,
 * only past the newest MAX. A send doesn't stay "Pending" for ever:
 * resolvePendingActivity() checks it on its own chain and marks it confirmed
 * or failed — failed also when, a day on, the chain has no record of it.
 * Same rules as the mobile app (apps/mobile/lib/local-activity.ts).
 */
export type LocalChain = 'evm' | 'bitcoin' | 'solana' | 'cosmos';

export interface LocalTx {
  /** Tx hash. Empty for a receive noticed from a balance change. */
  hash:          string;
  /** Stable row id — the hash, or "recv:<asset>:<ms>" for a noticed receive. */
  id?:           string;
  chain:         string; // LocalChain
  sym:           string;
  label:         'Sent' | 'Received';
  amount:        string; // human-readable, unsigned
  ts:            number; // epoch ms
  /** EVM chain it's on — what lets a pending send be checked. */
  chainId?:      number;
  networkName?:  string;
  tokenAddress?: string;
  /** Absent on rows saved before this field existed = pending. */
  status?:       'pending' | 'confirmed' | 'failed';
  /** Lithosphere's own transaction hash (64 hex, no 0x) — what LithoScan
   *  shows first. `hash` stays the 0x EVM hash: it's what a send is recorded
   *  and settled by. From the explorer row, or looked up once when a send's
   *  detail opens (setLocalNativeHash). */
  nativeHash?:   string;
}

const keyFor = (addr: string) => `thanos-local-activity:${(addr || '').toLowerCase()}`;
const MAX = 500;
/** After this long, a send its chain has never heard of counts as dropped. */
const DROPPED_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_RESOLVE_PER_PASS = 12;
const LOOKUP_TIMEOUT_MS = 6_000;

export const rowId = (t: LocalTx): string => t.id || t.hash;

function read(addr: string): LocalTx[] {
  if (!addr || typeof localStorage === 'undefined') return [];
  try {
    const arr = JSON.parse(localStorage.getItem(keyFor(addr)) || '[]');
    if (!Array.isArray(arr)) return [];
    return (arr as LocalTx[]).filter((t) => t && typeof t.ts === 'number' && (!!t.hash || !!t.id));
  } catch {
    return [];
  }
}

function write(addr: string, rows: LocalTx[]): void {
  try {
    const sorted = [...rows].sort((a, b) => b.ts - a.ts).slice(0, MAX);
    localStorage.setItem(keyFor(addr), JSON.stringify(sorted));
  } catch { /* quota / storage disabled — non-fatal */ }
}

/** The wallet's history, newest first. */
export function getLocalActivity(addr: string): LocalTx[] {
  return read(addr).sort((a, b) => b.ts - a.ts);
}

/** Record a just-broadcast send (after a hash came back). Deduped by hash. */
export function addLocalActivity(addr: string, tx: Omit<LocalTx, 'status' | 'label'> & { label?: 'Sent' }): void {
  if (!addr || !tx.hash) return;
  const arr = read(addr);
  if (arr.some((t) => t.hash && t.hash.toLowerCase() === tx.hash.toLowerCase())) return;
  write(addr, [{ ...tx, label: 'Sent', status: 'pending' }, ...arr]);
}

/** Record funds received that were noticed from a balance increase. */
export function addLocalReceive(addr: string, rx: Omit<LocalTx, 'hash' | 'label' | 'status'> & { id: string }): void {
  if (!addr || !rx.id) return;
  const arr = read(addr);
  if (arr.some((t) => rowId(t) === rx.id)) return;
  write(addr, [{ ...rx, hash: '', label: 'Received', status: 'confirmed' }, ...arr]);
}

const amountOf = (s: string) => parseFloat(String(s).replace(/[^0-9.]/g, '')) || 0;

/** Save rows the explorers reported (lib/explorer-activity.ts — one row per
 *  transfer, each with an id). The same transfer saved before — a send made
 *  here, or a row from before rows had ids — is matched by hash and direction
 *  and takes the explorer's verdict (and, on Lithosphere, the native hash)
 *  instead of being added twice. A receive noticed from a balance increase
 *  (no hash) gives way to the explorer's row for it. Anything else is new
 *  (older history, or another device's send).
 *  Returns true when something changed. */
export function mergeExplorerRows(addr: string, rows: LocalTx[]): boolean {
  if (!addr || rows.length === 0) return false;
  const arr = read(addr);
  const byId = new Map(arr.map((t) => [rowId(t).toLowerCase(), t]));
  let changed = false;
  for (const r of rows) {
    const id = rowId(r).toLowerCase();
    const hit = byId.get(id)
      ?? arr.find((t) => !t.id && !!t.hash && t.hash.toLowerCase() === r.hash.toLowerCase() && t.label === r.label);
    if (hit) {
      if (!hit.id && r.id) { byId.delete(rowId(hit).toLowerCase()); hit.id = r.id; byId.set(id, hit); changed = true; }
      if (r.status && r.status !== 'pending' && hit.status !== r.status) { hit.status = r.status; changed = true; }
      if (hit.chainId == null && r.chainId != null) { hit.chainId = r.chainId; hit.networkName = r.networkName; changed = true; }
      if (r.nativeHash && hit.nativeHash !== r.nativeHash) { hit.nativeHash = r.nativeHash; changed = true; }
      continue;
    }
    if (r.label === 'Received') {
      const a = amountOf(r.amount);
      const noticed = arr.findIndex((t) => !t.hash && t.label === 'Received' && t.sym === r.sym
        && (t.chainId ?? t.chain) === (r.chainId ?? r.chain)
        && Math.abs(amountOf(t.amount) - a) <= Math.max(1e-8, a * 1e-4)
        && t.ts >= r.ts - 5 * 60_000 && t.ts - r.ts < 3 * DROPPED_AFTER_MS);
      if (noticed >= 0) arr.splice(noticed, 1);
    }
    arr.push(r);
    byId.set(id, r);
    changed = true;
  }
  if (changed) write(addr, arr);
  return changed;
}

/** The saved native hash of a Lithosphere transaction known by its 0x hash. */
export function getLocalNativeHash(addr: string, evmHash: string): string | undefined {
  if (!addr || !evmHash) return undefined;
  const h = evmHash.toLowerCase();
  return read(addr).find((t) => !!t.nativeHash && !!t.hash && t.hash.toLowerCase() === h)?.nativeHash;
}

/** Save a Lithosphere transaction's native hash (from LithoScan) onto every
 *  row with its 0x hash, so it's looked up only once. */
export function setLocalNativeHash(addr: string, evmHash: string, nativeHash: string): void {
  if (!addr || !evmHash || !nativeHash) return;
  const h = evmHash.toLowerCase();
  const arr = read(addr);
  let changed = false;
  for (const t of arr) {
    if (t.hash && t.hash.toLowerCase() === h && t.nativeHash !== nativeHash) { t.nativeHash = nativeHash; changed = true; }
  }
  if (changed) write(addr, arr);
}

/* ─── Settling pending sends on their own chain ─────────────────────── */

/** confirmed / failed once settled, 'unknown' while the chain has no record
 *  of it, null when it couldn't be asked (or it's still in flight). */
type Lookup = 'confirmed' | 'failed' | 'unknown' | null;

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const timed = <T,>(p: Promise<T>) =>
  Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), LOOKUP_TIMEOUT_MS))]);

async function lookupEvmOn(chainId: number, hash: string): Promise<Lookup> {
  let evm: typeof import('./evm-external');
  try { evm = await import('./evm-external'); } catch { return null; }
  if (!evm.getExtEvmChain(chainId)) return null; // no RPC for this chain
  const provider = evm.getExtEvmProvider(chainId);
  try {
    const receipt = await timed(provider.getTransactionReceipt(hash));
    if (receipt === 'timeout') return null;
    if (receipt) return receipt.status === 1 ? 'confirmed' : 'failed';
    const tx = await timed(provider.getTransaction(hash));
    if (tx === 'timeout') return null;
    return tx ? null : 'unknown';
  } catch {
    return null;
  }
}

/** Sends saved before the chain was recorded: Lithosphere Mainnet first, then
 *  every other EVM network — the first that knows the hash decides. */
async function lookupEvmAnywhere(hash: string): Promise<Lookup> {
  let evm: typeof import('./evm-external');
  try { evm = await import('./evm-external'); } catch { return null; }
  const ids = [9005, ...evm.EXT_EVM_CHAINS.map((c) => c.chainId).filter((id) => id !== 9005)];
  // Every network that answered has never seen it; a public RPC or two being
  // unreachable shouldn't keep it "Pending" for ever, so most must answer.
  let answered = 0;
  for (const id of ids) {
    const r = await lookupEvmOn(id, hash);
    if (r === 'confirmed' || r === 'failed') return r;
    if (r === 'unknown') answered++;
  }
  return answered >= Math.min(5, ids.length) ? 'unknown' : null;
}

async function lookupBitcoin(hash: string): Promise<Lookup> {
  const r = await fetchJson(`https://mempool.space/api/tx/${encodeURIComponent(hash)}/status`);
  if (!r) return null;
  if (r.status === 404) return 'unknown';
  return (r.body as { confirmed?: boolean } | null)?.confirmed ? 'confirmed' : null;
}

async function lookupSolana(sig: string): Promise<Lookup> {
  for (const url of ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com']) {
    const r = await fetchJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[sig], { searchTransactionHistory: true }] }),
    });
    const value = (r?.body as { result?: { value?: Array<{ err: unknown; confirmationStatus?: string } | null> } } | null)?.result?.value;
    if (!Array.isArray(value)) continue;
    const s = value[0];
    if (!s) return 'unknown';
    if (s.err) return 'failed';
    return s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' ? 'confirmed' : null;
  }
  return null;
}

async function lookupCosmos(hash: string): Promise<Lookup> {
  const r = await fetchJson(`https://cosmos-rest.publicnode.com/cosmos/tx/v1beta1/txs/${encodeURIComponent(hash)}`);
  if (!r) return null;
  const code = (r.body as { tx_response?: { code?: number } } | null)?.tx_response?.code;
  if (r.status === 200 && typeof code === 'number') return code === 0 ? 'confirmed' : 'failed';
  return r.status === 404 || r.status === 400 ? 'unknown' : null;
}

function lookup(t: LocalTx): Promise<Lookup> {
  if (t.chainId != null) return lookupEvmOn(t.chainId, t.hash);
  if (t.chain === 'bitcoin') return lookupBitcoin(t.hash);
  if (t.chain === 'solana') return lookupSolana(t.hash);
  if (t.chain === 'cosmos') return lookupCosmos(t.hash);
  if (t.chain === 'evm') return lookupEvmAnywhere(t.hash);
  return Promise.resolve(null);
}

/** Check each still-pending send on its own chain and settle it in place.
 *  A chain that can't be reached leaves the row pending for the next pass.
 *  Returns the up-to-date history, newest first. */
export async function resolvePendingActivity(addr: string): Promise<LocalTx[]> {
  const arr = read(addr);
  if (!addr) return arr;
  const pending = arr.filter((t) => t.hash && (t.status ?? 'pending') === 'pending').slice(0, MAX_RESOLVE_PER_PASS);
  if (pending.length === 0) return getLocalActivity(addr);

  const now = Date.now();
  const results = await Promise.allSettled(pending.map(async (t) => {
    const r = await lookup(t);
    if (r === 'confirmed' || r === 'failed') return { hash: t.hash, status: r };
    if (r === 'unknown' && now - t.ts > DROPPED_AFTER_MS) return { hash: t.hash, status: 'failed' as const };
    return null;
  }));
  const updates = new Map<string, 'confirmed' | 'failed'>();
  for (const r of results) if (r.status === 'fulfilled' && r.value) updates.set(r.value.hash, r.value.status);
  if (updates.size === 0) return getLocalActivity(addr);

  // Re-read: another pass may have written meanwhile.
  const next = read(addr).map((t) => (t.hash && updates.has(t.hash) ? { ...t, status: updates.get(t.hash)! } : t));
  write(addr, next);
  return getLocalActivity(addr);
}
