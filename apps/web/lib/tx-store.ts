/**
 * Local pending-transaction store.
 *
 * Persists the user's broadcast-but-not-yet-confirmed txs in localStorage
 * so the UI can:
 *   - show a "Pending" panel in the Transactions view
 *   - offer a "Bump fee" affordance for BTC RBF
 *   - reconcile against indexer activity once the tx confirms
 *
 * The store is intentionally small and local. The backend doesn't need
 * to know about pending txs — the indexer will pick them up via Transfer
 * logs once they confirm. This is purely a UX layer.
 *
 * Storage key: thanos.pending_txs (JSON array of PendingTx)
 */

export type PendingTxStatus = 'broadcast' | 'replaced' | 'confirmed' | 'failed';

/** BTC-specific snapshot needed to build an RBF replacement. */
export interface BtcSnapshot {
  /** UTXOs spent by the original tx (txid + vout + value sat). Required
   *  so the replacement re-spends the same inputs. */
  inputs:        Array<{ txid: string; vout: number; valueSat: number }>;
  /** Recipient address (same on the replacement). */
  recipient:     string;
  /** Amount paid to the recipient (same on the replacement; the fee bump
   *  comes out of change, not out of the recipient's output). */
  amountSats:    number;
  /** The sender's own bc1q… address — used as the change destination on
   *  the replacement. */
  changeAddress: string;
  /** sat/vB used on the original broadcast. The replacement must beat it. */
  feeRateSatPerVb: number;
  /** Total fee paid (sats) on the original. */
  feeSats:       number;
  /** Rough vsize used to compute the fee. Inputs + outputs heuristic. */
  vbytes:        number;
}

export interface PendingTx {
  /** Stable id — for BTC this IS the txid; for other chains, txid/signature too. */
  id:         string;
  chain:      'bitcoin' | 'evm' | 'solana' | 'cosmos';
  /** EVM chain it went out on — what lets resolvePendingTxs check it. */
  chainId?:   number;
  /** 'in' for LITHO received (from the Mainnet explorer); sends omit it. */
  direction?: 'in' | 'out';
  symbol:     string;
  recipient:  string;
  /** Human-readable amount as entered by the user. */
  amount:     string;
  /** Optional contract address for EVM ERC-20 sends. */
  tokenAddress?: string;
  status:     PendingTxStatus;
  /** Original broadcast time (ms since epoch). */
  broadcastAt: number;
  /** Last status update (ms). */
  updatedAt:  number;
  /** When status becomes 'replaced', this points to the replacement's id. */
  replacedBy?: string;
  /** BTC-only: snapshot used to build an RBF replacement. */
  btc?:       BtcSnapshot;
}

const STORAGE_KEY = 'thanos.pending_txs';

export function loadPendingTxs(): PendingTx[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as PendingTx[];
  } catch {
    return [];
  }
}

function saveAll(list: PendingTx[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/** Append a tx (or replace if id already exists — useful for status updates). */
export function recordPendingTx(tx: PendingTx): void {
  const all = loadPendingTxs();
  const idx = all.findIndex(t => t.id === tx.id);
  if (idx >= 0) all[idx] = { ...tx, updatedAt: Date.now() };
  else          all.unshift({ ...tx, updatedAt: Date.now() });
  saveAll(all);
}

export function findPendingTx(id: string): PendingTx | null {
  return loadPendingTxs().find(t => t.id === id) ?? null;
}

/** Mark a tx replaced by a new one (RBF). Both tx rows remain so the user
 *  can see the chain of replacements; the UI hides the superseded ones. */
export function markReplaced(originalId: string, replacementId: string): void {
  const all = loadPendingTxs();
  const idx = all.findIndex(t => t.id === originalId);
  if (idx < 0) return;
  all[idx] = { ...all[idx], status: 'replaced', replacedBy: replacementId, updatedAt: Date.now() };
  saveAll(all);
}

export function markConfirmed(id: string): void {
  const all = loadPendingTxs();
  const idx = all.findIndex(t => t.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], status: 'confirmed', updatedAt: Date.now() };
  saveAll(all);
}

export function markFailed(id: string): void {
  const all = loadPendingTxs();
  const idx = all.findIndex(t => t.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], status: 'failed', updatedAt: Date.now() };
  saveAll(all);
}

/** Live (non-replaced, non-confirmed, non-failed) BTC txs that can be bumped. */
export function bumpableBtcTxs(): PendingTx[] {
  return loadPendingTxs().filter(t => t.chain === 'bitcoin' && t.status === 'broadcast' && t.btc);
}

/** Drop a tx entirely — used when the user clears history. */
export function removeTx(id: string): void {
  const next = loadPendingTxs().filter(t => t.id !== id);
  saveAll(next);
}

/* ─── History read layer ────────────────────────────────────────────────
   The Activity feed is this store: every send recorded at broadcast, plus
   native LITHO in and out on Lithosphere Mainnet from its explorer
   (syncExplorerHistory). The Thanos indexer only covers the Makalu testnet,
   which the wallet no longer includes, so nothing else reports them.

   History is kept (client 2026-10-15: sends "still pending" a day later) —
   confirmed and failed rows stay, only the newest MAX_LOCAL are kept, and
   a send doesn't stay "Pending" for ever: resolvePendingTxs() checks it on
   its own chain. Same rules as the mobile app, desktop and the extension. */

/** Max entries to retain in the local store. */
const MAX_LOCAL = 500;
/** After this long, a send its chain has never heard of counts as dropped. */
const DROPPED_AFTER_MS = 24 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 6_000;
const MAX_RESOLVE_PER_PASS = 12;

/** Cap the store to the newest MAX_LOCAL (by broadcast time). Writes back
 *  only when something was dropped. Returns the surviving list, newest first. */
export function prunePendingTxs(): PendingTx[] {
  const all = loadPendingTxs();
  const kept = [...all].sort((a, b) => (b.broadcastAt || 0) - (a.broadcastAt || 0)).slice(0, MAX_LOCAL);
  if (kept.length !== all.length) saveAll(kept);
  return kept;
}

/** A recorded transaction projected into the indexer's activity shape, so
 *  the Activity feed renders it through the same row projector. `local`
 *  marks it as coming from this store. */
export interface LocalActivityItem {
  id:            string;
  type:          'send' | 'receive';
  symbol:        string;
  amount:        string;
  counterparty?: string;
  txHash:        string;
  ts?:           string;
  status:        'pending' | 'confirmed' | 'failed';
  local:         true;
}

/**
 * The wallet's history as activity rows, newest first: pending sends, then
 * settled ones (confirmed / failed) and LITHO received on Mainnet. A
 * replaced (fee-bumped) tx is hidden — its replacement is the live one.
 * Rows whose hash the caller already shows (`indexedHashes`) are skipped.
 */
export function pendingActivityRows(indexedHashes: Iterable<string>): LocalActivityItem[] {
  const seen = new Set<string>();
  for (const h of indexedHashes) if (h) seen.add(h.toLowerCase());
  return prunePendingTxs()
    .filter(t => t.status !== 'replaced' && !seen.has(t.id.toLowerCase()))
    .map(t => ({
      id:           t.id,
      type:         t.direction === 'in' ? 'receive' as const : 'send' as const,
      symbol:       t.symbol,
      amount:       t.amount,
      counterparty: t.recipient,
      txHash:       t.id,
      ts:           new Date(t.broadcastAt).toISOString(),
      status:       t.status === 'broadcast' ? 'pending' as const : t.status === 'failed' ? 'failed' as const : 'confirmed' as const,
      local:        true as const,
    }));
}

/* ─── Settling pending sends on their own chain ─────────────────────── */

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
  let m: typeof import('./evm-chains');
  try { m = await import('./evm-chains'); } catch { return null; }
  if (!m.findEvmChain(chainId)) return null;
  try {
    const provider = m.getEvmProvider(chainId);
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

/** Sends saved before the chain was recorded: Lithosphere Mainnet first,
 *  then the other built-in EVM networks; most must answer for "unknown". */
async function lookupEvmAnywhere(hash: string): Promise<Lookup> {
  let m: typeof import('./evm-chains');
  try { m = await import('./evm-chains'); } catch { return null; }
  const ids = [9005, ...m.EVM_CHAINS.map(c => c.chainId).filter(id => id !== 9005)];
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

function lookup(t: PendingTx): Promise<Lookup> {
  if (t.chain === 'bitcoin') return lookupBitcoin(t.id);
  if (t.chain === 'solana') return lookupSolana(t.id);
  if (t.chain === 'cosmos') return lookupCosmos(t.id);
  return t.chainId != null ? lookupEvmOn(t.chainId, t.id) : lookupEvmAnywhere(t.id);
}

let resolving = false;
/** Check each still-pending send on its own chain and settle it in place:
 *  confirmed, failed (reverted), or failed because a day on its chain has
 *  no record of it. An unreachable chain leaves it pending for next time.
 *  Returns true when anything changed. */
export async function resolvePendingTxs(): Promise<boolean> {
  if (resolving || typeof window === 'undefined') return false;
  resolving = true;
  try {
    const pending = loadPendingTxs().filter(t => t.status === 'broadcast').slice(0, MAX_RESOLVE_PER_PASS);
    if (pending.length === 0) return false;
    const now = Date.now();
    const results = await Promise.allSettled(pending.map(async (t) => {
      const r = await lookup(t);
      if (r === 'confirmed' || r === 'failed') return { id: t.id, status: r };
      if (r === 'unknown' && now - (t.broadcastAt || 0) > DROPPED_AFTER_MS) return { id: t.id, status: 'failed' as const };
      return null;
    }));
    let changed = false;
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      if (r.value.status === 'confirmed') markConfirmed(r.value.id); else markFailed(r.value.id);
      changed = true;
    }
    return changed;
  } finally {
    resolving = false;
  }
}

/* ─── Lithosphere Mainnet explorer ─────────────────────────────────── */

interface ExplorerTx {
  hash?: string; evmHash?: string; value?: string; inputData?: string;
  timestamp?: string; evmFromAddr?: string; evmToAddr?: string; success?: boolean;
}

/** Save native LITHO in and out for `address` from lithoscan.ai
 *  (GET /api/address/<addr>/txs) into the history: new rows are added as
 *  settled, and a pending send the explorer has seen takes its verdict.
 *  Returns true when anything changed. */
export async function syncExplorerHistory(address: string): Promise<boolean> {
  if (!address || typeof window === 'undefined') return false;
  const r = await fetchJson(`https://lithoscan.ai/api/address/${encodeURIComponent(address)}/txs?limit=50`);
  const items = (r?.body as { items?: ExplorerTx[]; txs?: ExplorerTx[] } | null)?.items
    ?? (r?.body as { txs?: ExplorerTx[] } | null)?.txs;
  if (!Array.isArray(items)) return false;
  const me = address.toLowerCase();
  const all = loadPendingTxs();
  const byId = new Map(all.map(t => [t.id.toLowerCase(), t]));
  let changed = false;
  for (const t of items) {
    const from = (t.evmFromAddr ?? '').toLowerCase();
    const to = (t.evmToAddr ?? '').toLowerCase();
    if (from !== me && to !== me) continue;
    if ((t.inputData ?? '0x') !== '0x') continue; // native transfers only
    let wei = 0n;
    try { wei = BigInt(t.value ?? '0'); } catch { continue; }
    if (wei <= 0n) continue;
    const hash = t.evmHash || t.hash || '';
    if (!hash) continue;
    const status: PendingTxStatus = t.success === false ? 'failed' : 'confirmed';
    const hit = byId.get(hash.toLowerCase());
    if (hit) {
      if (hit.status === 'broadcast') { hit.status = status; hit.updatedAt = Date.now(); changed = true; }
      continue;
    }
    const ts = t.timestamp ? Date.parse(t.timestamp) : NaN;
    const row: PendingTx = {
      id: hash, chain: 'evm', chainId: 9005, symbol: 'LITHO',
      recipient: to === me ? (t.evmFromAddr ?? '') : (t.evmToAddr ?? ''),
      amount: (Number(wei) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 8, useGrouping: false }),
      direction: to === me ? 'in' : 'out',
      status, broadcastAt: Number.isFinite(ts) ? ts : Date.now(), updatedAt: Date.now(),
    };
    all.push(row); byId.set(hash.toLowerCase(), row); changed = true;
  }
  if (changed) saveAll(all);
  return changed;
}
