/**
 * The Activity feed, kept on this device (desktop), keyed by the wallet's EVM
 * address:
 *   - every successful send, recorded at broadcast (addLocalActivity);
 *   - the wallet's full history on every network, from each network's
 *     explorer (explorer-activity.ts — client 2026-10-15: "all previous
 *     transactions"), saved here so it stays after leaving an explorer's
 *     latest page (mergeHistoryRows).
 *
 * RESOLUTION (added 2026-09-16, client-reported "need all activity to show" /
 * stuck-Pending rows): a send is promoted out of "Pending" by its explorer's
 * row where an explorer covers the network. Until then (and on every other
 * network) resolvePendingActivity() polls the tx's OWN chain RPC directly for
 * a receipt and flips the stored status in place, so the row stays (doesn't
 * vanish) but shows as sent/failed correctly.
 *
 * HISTORY (2026-10-15, client: sends "still pending" a day later): rows are
 * no longer dropped after 24h — only past the newest MAX — and Bitcoin,
 * Solana and Cosmos sends are settled too (mempool.space,
 * getSignatureStatuses, the Cosmos REST tx query). A send its chain has no
 * record of a day on is marked failed instead of pending for ever. Same
 * rules as the mobile app and the extension.
 */
export interface LocalTx {
  hash:     string;
  chain:    string;
  sym:      string;
  amount:   string;
  ts:       number; // epoch ms
  /** The chain this was actually broadcast on — every EVM send passes the
   *  coin's chainId, which is what resolvePendingActivity polls. */
  chainId?: number;
  /** Absent/'pending' = still unresolved. Rows recorded before this field
   *  existed are treated as pending (backward compatible). */
  status?:  'pending' | 'confirmed' | 'failed';
  /** Explorer rows: fetchChainHistory's per-transfer id (a swap's legs share
   *  one hash). A send recorded here has none until its explorer reports it. */
  id?:           string;
  /** Absent = a send made here. */
  direction?:    'in' | 'out';
  networkName?:  string;
  counterparty?: string;
  tokenAddress?: string;
  /** Lithosphere Mainnet: the transaction's native hash (64 hex, no 0x) —
   *  what LithoScan shows first. `hash` stays the 0x EVM hash. Comes with
   *  LithoScan's rows; a send made here gets it from setNativeHash once
   *  LithoScan has indexed it. */
  nativeHash?:   string;
}

const keyFor = (addr: string) => `thanos-local-activity:${(addr || '').toLowerCase()}`;
const MAX = 500;
/** After this long, a send its chain has never heard of counts as dropped. */
const DROPPED_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_RESOLVE_PER_PASS = 12;
const RECEIPT_TIMEOUT_MS = 6_000;

export function getLocalActivity(addr: string): LocalTx[] {
  if (!addr || typeof localStorage === 'undefined') return [];
  try {
    const arr = JSON.parse(localStorage.getItem(keyFor(addr)) || '[]');
    if (!Array.isArray(arr)) return [];
    // History is kept; a send that never settles is marked failed by
    // resolvePendingActivity instead of being deleted.
    return (arr as LocalTx[]).filter((t) => Number.isFinite(t?.ts) && !!t.hash);
  } catch {
    return [];
  }
}

export function addLocalActivity(addr: string, tx: LocalTx): void {
  if (!addr || !tx.hash || typeof localStorage === 'undefined') return;
  try {
    const arr = getLocalActivity(addr);
    if (arr.some((t) => t.hash === tx.hash)) return;
    localStorage.setItem(keyFor(addr), JSON.stringify([{ ...tx, status: 'pending' as const }, ...arr].slice(0, MAX)));
  } catch {
    /* storage full / disabled — non-fatal */
  }
}

const keyOf = (t: LocalTx) => (t.id || t.hash).toLowerCase();

/** Save rows the explorers reported (explorer-activity.ts), deduped by row id
 *  (a row without one by hash). A send recorded here with the same hash takes
 *  the explorer's verdict instead of being listed twice — its outgoing row
 *  takes the send's place, keeping what was recorded at broadcast. Anything
 *  else is new (older history, a receive, or a send from another wallet).
 *  A Lithosphere row's native hash is carried onto the saved row either way.
 *  Keeps the newest MAX. Returns true when the saved list changed. */
export function mergeHistoryRows(addr: string, rows: LocalTx[]): boolean {
  if (!addr || rows.length === 0 || typeof localStorage === 'undefined') return false;
  const arr = getLocalActivity(addr);
  const byKey = new Map(arr.map((t) => [keyOf(t), t]));
  const settle = (t: LocalTx, r: LocalTx) => {
    if (r.status && r.status !== 'pending') t.status = r.status;
    if (r.nativeHash && !t.nativeHash) t.nativeHash = r.nativeHash;
  };
  for (const r of rows) {
    const hit = byKey.get(keyOf(r));
    if (hit) { settle(hit, r); continue; }
    const sent = arr.find((t) => !t.id && t.hash.toLowerCase() === r.hash.toLowerCase());
    if (sent) settle(sent, r);
    if (sent && r.direction === 'out') {
      byKey.delete(keyOf(sent));
      Object.assign(sent, {
        id: r.id, direction: r.direction, networkName: r.networkName,
        counterparty: r.counterparty, tokenAddress: r.tokenAddress,
        chainId: sent.chainId ?? r.chainId,
      });
      byKey.set(keyOf(sent), sent);
      continue;
    }
    arr.push(r);
    byKey.set(keyOf(r), r);
  }
  arr.sort((a, b) => b.ts - a.ts);
  // Compared as saved: past MAX, the oldest rows come back from every full
  // read and drop off again — that isn't a change.
  const next = JSON.stringify(arr.slice(0, MAX));
  try {
    if (localStorage.getItem(keyFor(addr)) === next) return false;
    localStorage.setItem(keyFor(addr), next);
    return true;
  } catch {
    return false; // storage full / disabled — non-fatal
  }
}

/** Save the native hash LithoScan gave for a Lithosphere transaction known by
 *  its 0x EVM hash (a send made here, or a row saved before rows carried it),
 *  so it's looked up only once. Returns true when a saved row changed. */
export function setNativeHash(addr: string, evmHash: string, nativeHash: string): boolean {
  if (!addr || !evmHash || !nativeHash || typeof localStorage === 'undefined') return false;
  const h = evmHash.toLowerCase();
  let changed = false;
  const next = getLocalActivity(addr).map((t) => {
    if (t.hash.toLowerCase() !== h || t.nativeHash) return t;
    changed = true;
    return { ...t, nativeHash };
  });
  if (!changed) return false;
  try { localStorage.setItem(keyFor(addr), JSON.stringify(next)); return true; } catch { return false; }
}

type Lookup = 'confirmed' | 'failed' | 'unknown' | null;

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RECEIPT_TIMEOUT_MS);
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
  Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), RECEIPT_TIMEOUT_MS))]);

async function lookupEvm(chainId: number, hash: string): Promise<Lookup> {
  let evm: typeof import('./evm-external');
  try { evm = await import('./evm-external'); } catch { return null; }
  if (!evm.getExtEvmChain(chainId)) return null; // not a chain this module knows an RPC for
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
    const st = value[0];
    if (!st) return 'unknown';
    if (st.err) return 'failed';
    return st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized' ? 'confirmed' : null;
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
  if (t.chainId != null) return lookupEvm(t.chainId, t.hash);
  if (t.chain === 'bitcoin') return lookupBitcoin(t.hash);
  if (t.chain === 'solana') return lookupSolana(t.hash);
  if (t.chain === 'cosmos') return lookupCosmos(t.hash);
  return Promise.resolve(null);
}

/** Check each still-pending send on its OWN chain and settle it in place:
 *  confirmed, failed (reverted), or failed because a day on the chain has no
 *  record of it. An unreachable chain leaves the row pending for the next
 *  call (portfolio load / reload). Returns the up-to-date list. */
export async function resolvePendingActivity(addr: string): Promise<LocalTx[]> {
  const arr = getLocalActivity(addr);
  if (!addr) return arr;
  const pending = arr.filter((t) => (t.status ?? 'pending') === 'pending').slice(0, MAX_RESOLVE_PER_PASS);
  if (pending.length === 0) return arr;

  const now = Date.now();
  const results = await Promise.allSettled(pending.map(async (t) => {
    const r = await lookup(t);
    if (r === 'confirmed' || r === 'failed') return { hash: t.hash, status: r };
    if (r === 'unknown' && now - t.ts > DROPPED_AFTER_MS) return { hash: t.hash, status: 'failed' as const };
    return null;
  }));
  const updates = new Map<string, 'confirmed' | 'failed'>();
  for (const r of results) if (r.status === 'fulfilled' && r.value) updates.set(r.value.hash, r.value.status);
  if (updates.size === 0) return arr;

  const next = getLocalActivity(addr).map((t) => (updates.has(t.hash) ? { ...t, status: updates.get(t.hash)! } : t));
  try { localStorage.setItem(keyFor(addr), JSON.stringify(next)); } catch { /* best-effort */ }
  return next;
}
