/**
 * Multi-account derivation index — mobile.
 *
 * AsyncStorage is async by API, but the signer (wc-signer.ts) needs to
 * read the active index *synchronously* at sign time. We solve this
 * with an in-memory cache that hydrates from AsyncStorage on app start
 * via `loadAccountsFromStorage()`, then every subsequent get/set is
 * sync against the cache; writes are mirrored to AsyncStorage as
 * fire-and-forget so a fresh launch sees the last persisted value.
 *
 * Same surface as web/desktop/extension vault.ts so consumers don't
 * branch on platform.
 *
 * Several wallets (lib/vault.ts): each wallet in the vault has its own copy
 * of these settings — the first wallet ('w0') under the original keys, so
 * existing installs keep theirs, and every wallet added after it under
 * `<key>@<walletId>` (same scheme as the extension). The cache always holds
 * the OPEN wallet's settings; opening another wallet re-hydrates it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_ACTIVE_IDX = 'thanos.active_account_idx';
const KEY_ACCT_COUNT = 'thanos.account_count';
const KEY_ACCT_NAMES = 'thanos.account_names';
const KEY_ACCT_HIDDEN = 'thanos.account_hidden';
/** Public per-wallet metadata — never a secret: how the wallet came in
 *  (created here / imported) and its accounts' derived 0x addresses, so the
 *  account sheet can list every wallet's accounts without decrypting and
 *  re-deriving each one. { [walletId]: { origin?, addrs?: { [idx]: '0x…' } } } */
const KEY_WALLET_META = 'thanos.wallet_meta';
/** Superseded by KEY_WALLET_META (one active address per wallet) — removed when seen. */
const KEY_WALLET_ADDRS_OLD = 'thanos.wallet_addrs';
const PER_WALLET_KEYS = [KEY_ACTIVE_IDX, KEY_ACCT_COUNT, KEY_ACCT_NAMES, KEY_ACCT_HIDDEN];
export const MAX_ACCOUNTS = 10;
export const MAX_ACCOUNT_NAME_LEN = 24;

/** The wallet every vault starts with — and the only one any vault held
 *  before multi-wallet. Its settings keep the un-suffixed keys. */
export const FIRST_WALLET_ID = 'w0';

// In-memory cache. Sentinel until hydrated; UI handles the "0/1 by default" case.
let _walletId     = FIRST_WALLET_ID;
let _activeIdx    = 0;
let _accountCount = 1;
let _names: Record<number, string> = {};
let _hidden: number[] = [];
let _meta: Record<string, WalletMeta> = {};
let _hydrated     = false;
// Bumped by every load, so a slower, older load never overwrites a newer one
// (e.g. the boot hydration finishing after a wallet was already opened).
let _loadGen      = 0;

/** AsyncStorage key for a wallet's copy of a per-wallet setting. */
export function walletKey(base: string, walletId = _walletId): string {
  return walletId === FIRST_WALLET_ID ? base : `${base}@${walletId}`;
}

/** The wallet whose settings the cache holds (the open wallet). */
export function currentWalletId(): string { return _walletId; }

function parseIntIn(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? String(fallback), 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
function parseHidden(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown[];
    return arr.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < MAX_ACCOUNTS);
  } catch { return []; }
}
function parseNames(raw: string | null): Record<number, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const clean: Record<number, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const i = Number.parseInt(k, 10);
      if (Number.isInteger(i) && i >= 0 && i < MAX_ACCOUNTS && typeof v === 'string' && v.trim()) {
        clean[i] = v.trim().slice(0, MAX_ACCOUNT_NAME_LEN);
      }
    }
    return clean;
  } catch { return {}; }
}
const isAddr = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/.test(v);
function parseMeta(raw: string | null): Record<string, WalletMeta> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, { origin?: unknown; addrs?: Record<string, unknown> }>;
    const out: Record<string, WalletMeta> = {};
    for (const [id, m] of Object.entries(parsed)) {
      if (!m || typeof m !== 'object') continue;
      const meta: WalletMeta = {};
      if (m.origin === 'created' || m.origin === 'imported') meta.origin = m.origin;
      if (m.addrs && typeof m.addrs === 'object') {
        const addrs: Record<number, string> = {};
        for (const [k, v] of Object.entries(m.addrs)) {
          const i = Number.parseInt(k, 10);
          if (Number.isInteger(i) && i >= 0 && i < MAX_ACCOUNTS && isAddr(v)) addrs[i] = v;
        }
        meta.addrs = addrs;
      }
      out[id] = meta;
    }
    return out;
  } catch { return {}; }
}

/** Hydrate from AsyncStorage. Call once at app start; safe to re-call.
 *  Given a wallet id, the cache switches to that wallet's settings (opening
 *  a wallet — lib/vault.ts selectWallet). */
export async function loadAccountsFromStorage(walletId?: string): Promise<void> {
  if (walletId !== undefined && walletId !== _walletId) {
    // Never show (or write) the previous wallet's values under the new one.
    _walletId = walletId;
    _activeIdx = 0; _accountCount = 1; _names = {}; _hidden = [];
  }
  const gen = ++_loadGen;
  const id = _walletId;
  try {
    const [[, idxRaw], [, countRaw], [, namesRaw], [, hiddenRaw], [, metaRaw], [, oldAddrsRaw]] = await AsyncStorage.multiGet([
      ...PER_WALLET_KEYS.map((k) => walletKey(k, id)), KEY_WALLET_META, KEY_WALLET_ADDRS_OLD,
    ]);
    if (oldAddrsRaw !== null) AsyncStorage.removeItem(KEY_WALLET_ADDRS_OLD).catch(() => {});
    if (gen !== _loadGen) return;
    _hidden = parseHidden(hiddenRaw);
    _activeIdx    = parseIntIn(idxRaw, 0, 0, MAX_ACCOUNTS - 1);
    _accountCount = parseIntIn(countRaw, 1, 1, MAX_ACCOUNTS);
    // Merge: anything recorded in memory since (e.g. by an earlier load's
    // caller) wins over what was read.
    const stored = parseMeta(metaRaw);
    for (const [k, m] of Object.entries(_meta)) stored[k] = { ...stored[k], ...m, addrs: { ...stored[k]?.addrs, ...m.addrs } };
    _meta = stored;
    if (namesRaw) _names = parseNames(namesRaw);
  } catch { /* keep defaults */ }
  if (gen === _loadGen) _hydrated = true;
}

export function getActiveAccountIndex(): number { return _activeIdx; }
export function getAccountCount(): number       { return _accountCount; }
export function isAccountsHydrated(): boolean   { return _hydrated; }

export function setActiveAccountIndex(idx: number): void {
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_ACCOUNTS) return;
  _activeIdx = idx;
  AsyncStorage.setItem(walletKey(KEY_ACTIVE_IDX), String(idx)).catch(() => {});
}

export function setAccountCount(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_ACCOUNTS) return;
  _accountCount = n;
  AsyncStorage.setItem(walletKey(KEY_ACCT_COUNT), String(n)).catch(() => {});
}

/** Display name for an account — the user's custom name, else "Account N". */
export function getAccountName(idx: number): string {
  const custom = _names[idx]?.trim();
  return custom || `Account ${idx + 1}`;
}

/** The custom name only (null when the account uses the default). */
export function getCustomAccountName(idx: number): string | null {
  return _names[idx] ?? null;
}

/** Set (or clear, with an empty string) an account's custom name. */
export function setAccountName(idx: number, name: string): void {
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_ACCOUNTS) return;
  const trimmed = name.trim().slice(0, MAX_ACCOUNT_NAME_LEN);
  if (trimmed) _names[idx] = trimmed;
  else delete _names[idx];
  AsyncStorage.setItem(walletKey(KEY_ACCT_NAMES), JSON.stringify(_names)).catch(() => {});
}

/* ─── Account removal ────────────────────────────────────────────────────
   Accounts are HD-path indices, so an account CANNOT be spliced out: removing
   index 1 of 0..2 would slide index 2 down and silently change that account's
   address — funds would look like they vanished. A removed account is instead
   recorded in a HIDDEN set; every index keeps deriving the same address
   forever and the account simply stops being listed. Mirrors web/desktop/
   extension vault.ts (same storage key). */

export function getHiddenAccounts(): number[] { return [..._hidden]; }
export function isAccountHidden(idx: number): boolean { return _hidden.includes(idx); }

function visibleOf(count: number, hidden: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (!hidden.includes(i)) out.push(i);
  return out.length ? out : [0];
}

/** Indices the UI should list. Never empty — a wallet always keeps one. */
export function getVisibleAccountIndices(): number[] {
  return visibleOf(_accountCount, _hidden);
}

/** Hide (delete) an account. Refuses the last visible one — a wallet must
 *  always keep at least one. Balance checks live in the UI, the only layer
 *  that can price what the account holds. */
export function hideAccount(idx: number): boolean {
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_ACCOUNTS) return false;
  const visible = getVisibleAccountIndices();
  if (visible.length <= 1 || !visible.includes(idx)) return false;
  if (!_hidden.includes(idx)) _hidden.push(idx);
  AsyncStorage.setItem(walletKey(KEY_ACCT_HIDDEN), JSON.stringify(_hidden)).catch(() => {});
  // Never leave the wallet pointing at a removed account.
  if (_activeIdx === idx) setActiveAccountIndex(getVisibleAccountIndices()[0] ?? 0);
  return true;
}

/* ─── Other wallets in the vault ──────────────────────────────────────── */

/** A wallet's accounts as the account sheet lists them. */
export interface WalletAccounts {
  /** Its active account (the one it opens on). */
  active: number;
  /** Listed (not hidden) indices, ascending. */
  visible: number[];
  /** How many indices have been provisioned (hidden ones included). */
  count: number;
  /** Custom names; the rest are "Account N". */
  names: Record<number, string>;
}

/** Any wallet's accounts — the cache for the open one, storage for the others. */
export async function readWalletAccounts(walletId: string): Promise<WalletAccounts> {
  if (walletId === _walletId) {
    return { active: _activeIdx, visible: getVisibleAccountIndices(), count: _accountCount, names: { ..._names } };
  }
  try {
    const [[, idxRaw], [, countRaw], [, namesRaw], [, hiddenRaw]] = await AsyncStorage.multiGet(PER_WALLET_KEYS.map((k) => walletKey(k, walletId)));
    const count = parseIntIn(countRaw, 1, 1, MAX_ACCOUNTS);
    const visible = visibleOf(count, parseHidden(hiddenRaw));
    const idx = parseIntIn(idxRaw, 0, 0, MAX_ACCOUNTS - 1);
    return { active: visible.includes(idx) ? idx : visible[0], visible, count, names: parseNames(namesRaw) };
  } catch {
    return { active: 0, visible: [0], count: 1, names: {} };
  }
}

/* ─── Public per-wallet metadata (KEY_WALLET_META) ───────────────────────── */
export type WalletOrigin = 'created' | 'imported';
interface WalletMeta { origin?: WalletOrigin; addrs?: Record<number, string> }

function saveMeta(): void {
  AsyncStorage.setItem(KEY_WALLET_META, JSON.stringify(_meta)).catch(() => {});
}

/** Created in Thanos or imported — unknown for wallets from before this was recorded. */
export function getWalletOrigin(walletId: string): WalletOrigin | undefined { return _meta[walletId]?.origin; }

export function setWalletOrigin(walletId: string, origin: WalletOrigin): void {
  if (_meta[walletId]?.origin === origin) return;
  _meta = { ..._meta, [walletId]: { ..._meta[walletId], origin } };
  saveMeta();
}

/** A wallet's known account addresses (0x) by HD index. */
export function getWalletAddresses(walletId: string): Record<number, string> {
  return { ..._meta[walletId]?.addrs };
}

/** Record derived account addresses (merged into what's known; public data). */
export function setWalletAddresses(walletId: string, addrs: Record<number, string>): void {
  const known = _meta[walletId]?.addrs ?? {};
  const next = { ...known };
  let changed = false;
  for (const [k, v] of Object.entries(addrs)) {
    const i = Number(k);
    if (Number.isInteger(i) && i >= 0 && i < MAX_ACCOUNTS && isAddr(v) && known[i] !== v) { next[i] = v; changed = true; }
  }
  if (!changed) return;
  _meta = { ..._meta, [walletId]: { ..._meta[walletId], addrs: next } };
  saveMeta();
}

/** Drop a removed wallet's settings and metadata. */
export async function forgetWalletSettings(walletId: string): Promise<void> {
  if (walletId in _meta) {
    const rest = { ..._meta };
    delete rest[walletId];
    _meta = rest;
    await AsyncStorage.setItem(KEY_WALLET_META, JSON.stringify(rest)).catch(() => {});
  }
  await AsyncStorage.multiRemove(PER_WALLET_KEYS.map((k) => walletKey(k, walletId))).catch(() => {});
}

/** Every wallet deleted from the device (lib/vault.ts clearVault): drop the
 *  added wallets' settings and all wallet metadata, and point the cache back
 *  at the first wallet, whose own keys are left exactly as they always were. */
export async function forgetAddedWallets(): Promise<void> {
  _meta = {};
  try {
    const keys = await AsyncStorage.getAllKeys();
    const added = keys.filter((k) => PER_WALLET_KEYS.some((base) => k.startsWith(`${base}@`)));
    await AsyncStorage.multiRemove([...added, KEY_WALLET_META, KEY_WALLET_ADDRS_OLD]);
  } catch { /* best-effort */ }
  await loadAccountsFromStorage(FIRST_WALLET_ID);
}
