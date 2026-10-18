/**
 * Encrypted mnemonic vault.
 *
 * On disk (localStorage):
 *   thanos.vault    — JSON: { v, kdf params, salt, iv, ciphertext }
 *   thanos.has_vault — quick existence flag (mirrors the legacy key)
 *
 * Per popup (sessionStorage):
 *   thanos.session_key — 32-byte AES key (hex) for the life of the popup
 *   page. Between popup opens the key is kept in chrome.storage.session
 *   (RAM-backed, gone when the browser closes) for the chosen session
 *   length — see entrypoints/popup/session-store.ts. Never on disk.
 *
 * Crypto:
 *   - Key derivation:   PBKDF2-SHA256, 600,000 iterations for new vaults;
 *                       older vaults keep the Argon2id parameters stored
 *                       with them (t=3, m=64MB, p=4)
 *   - Encryption:       AES-256-GCM (12-byte random IV)    — authenticated
 *   - Wrong password:   GCM tag mismatch -> decrypt throws -> we return null
 *
 * Storage size: vault is ~280 bytes encoded per wallet. The plaintext is
 * one secret, or a set of several wallets — see "Several wallets in one
 * vault" below.
 */

// hash-wasm's Argon2 is now lazy-loaded (only to open a LEGACY argon2id
// vault) — new installs never pull the WASM module. New vaults derive their
// AES key with native WebCrypto PBKDF2 (see deriveKeyPbkdf2 below).

/* ─── On-disk format ─────────────────────────────────────────────────────── */
export type VaultKdf =
  | { type: 'pbkdf2';   c: number; hash: 'sha256' }
  | { type: 'argon2id'; t: number; m: number; p: number };

export interface EncryptedVault {
  v: 1;
  /** KDF that derived the AES key — stored so the vault always opens with the
   *  exact KDF it was created with. New vaults: pbkdf2. Legacy: argon2id. */
  kdf: VaultKdf;
  /** All bytes hex-encoded so localStorage can JSON-serialise cleanly. */
  salt:       string;
  iv:         string;
  ciphertext: string;
}

const STORAGE_KEYS = {
  vault:      'thanos.vault',
  hasVault:   'thanos.has_vault',
  sessionKey: 'thanos.session_key',
  /* Set once the user has provably recorded their recovery phrase (after
     the create-flow verification step, or on import). Absent for legacy/
     migrated vaults, which then get a backup nudge. */
  seedBackedUp: 'thanos.seed_backed_up',
  /* Legacy keys we migrate from on first load (then clear). */
  legacyMnemonic: 'thanos.mnemonic',
  legacyPassword: 'thanos.password',
  legacyUnlocked: 'thanos.unlocked',
} as const;

/* New vaults derive the AES key with PBKDF2-HMAC-SHA256 via native WebCrypto
   (crypto.subtle) — ~50-100ms (native C++), no WASM module to load, and the
   same KDF family the mobile client uses. 600k iterations = OWASP 2023.
   Sound here: the vault is device-local AND already wrapped in the browser's
   own extension storage, so the password KDF is a second layer. Legacy
   argon2id vaults still open via the lazy hash-wasm path below. */
const PBKDF2_ITERS = 600_000;
const KEY_BITS = 256; // AES-256

/* ─── Hex helpers (avoids Buffer in browser bundle) ─────────────────────── */
function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2) throw new Error('vault: odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

/* ─── Key derivation ────────────────────────────────────────────────────── */
/** New vaults: native PBKDF2-HMAC-SHA256 via WebCrypto. */
async function deriveKeyPbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password) as BufferSource, 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    base, KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Legacy vaults only: Argon2id via hash-wasm, lazy-imported so new installs
 *  never load the WASM. Uses the vault's own stored params. */
async function deriveKeyArgon2(password: string, salt: Uint8Array, params: { t: number; m: number; p: number }): Promise<Uint8Array> {
  const { argon2id } = await import('hash-wasm');
  const hashHex = await argon2id({
    password, salt,
    parallelism: params.p, iterations: params.t, memorySize: params.m,
    hashLength: 32, outputType: 'hex',
  });
  return hexToBytes(hashHex);
}

/** Derive the AES key for a vault's stored KDF block. */
async function deriveForKdf(password: string, salt: Uint8Array, kdf: VaultKdf): Promise<Uint8Array> {
  return kdf.type === 'pbkdf2'
    ? deriveKeyPbkdf2(password, salt, kdf.c)
    : deriveKeyArgon2(password, salt, kdf);
}

/* ─── AES-256-GCM encrypt / decrypt ─────────────────────────────────────── */
async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    rawKey as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/* ─── Public API ────────────────────────────────────────────────────────── */

/** Encrypt a mnemonic string with the user's password. */
export async function createVault(mnemonic: string, password: string): Promise<EncryptedVault> {
  const salt = randomBytes(16);
  const iv   = randomBytes(12);
  const keyBytes = await deriveKeyPbkdf2(password, salt, PBKDF2_ITERS);
  const aes = await importAesKey(keyBytes);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    aes,
    new TextEncoder().encode(mnemonic) as BufferSource,
  );
  return {
    v: 1,
    kdf: { type: 'pbkdf2', c: PBKDF2_ITERS, hash: 'sha256' },
    salt:       bytesToHex(salt),
    iv:         bytesToHex(iv),
    ciphertext: bytesToHex(new Uint8Array(ct)),
  };
}

/**
 * Decrypt with the user's password. Returns the mnemonic, or null if the
 * password is wrong (AES-GCM auth-tag mismatch).
 *
 * Also returns the raw AES key bytes so the caller can session-cache them
 * for the "refresh doesn't re-prompt" UX.
 */
export async function openVault(
  vault: EncryptedVault,
  password: string,
): Promise<{ mnemonic: string; key: Uint8Array } | null> {
  if (vault.v !== 1) throw new Error(`vault: unsupported version ${vault.v}`);
  const salt = hexToBytes(vault.salt);
  // Derive with the vault's OWN stored KDF (pbkdf2 for new vaults, argon2id
  // for legacy ones) so every vault unlocks with exactly what it was made with.
  const keyBytes = await deriveForKdf(password, salt, vault.kdf);
  try {
    const aes = await importAesKey(keyBytes);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(vault.iv) as BufferSource },
      aes,
      hexToBytes(vault.ciphertext) as BufferSource,
    );
    return { mnemonic: new TextDecoder().decode(pt), key: keyBytes };
  } catch {
    return null; // wrong password / tampered vault
  }
}

/** Decrypt with a session-cached raw AES key (refresh case). */
export async function openVaultWithKey(
  vault: EncryptedVault,
  keyBytes: Uint8Array,
): Promise<string | null> {
  try {
    const aes = await importAesKey(keyBytes);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(vault.iv) as BufferSource },
      aes,
      hexToBytes(vault.ciphertext) as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/* ─── Storage layer ─────────────────────────────────────────────────────── */
export function saveVault(vault: EncryptedVault): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEYS.vault, JSON.stringify(vault));
  localStorage.setItem(STORAGE_KEYS.hasVault, '1');
}

export function loadVault(): EncryptedVault | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEYS.vault);
  if (!raw) return null;
  try { return JSON.parse(raw) as EncryptedVault; } catch { return null; }
}

/* ─── Several wallets in one vault ──────────────────────────────────────
 * The encrypted plaintext is either one secret (a phrase or a 0x key —
 * every vault made before multi-wallet, and any vault that only ever held
 * one wallet) or a wallet set: JSON { format, wallets: [{ id, name, secret }] }.
 * One password and one AES key cover them all; adding or removing a wallet
 * re-encrypts with the cached session key, so the password never changes.
 * Same model and plaintext format as the phone (apps/mobile/lib/vault.ts).
 *
 * Per-wallet state (active account, account count, names, hidden accounts,
 * backup flag) lives under the same localStorage keys as before for the
 * first wallet ('w0' — so existing installs keep theirs) and under
 * `<key>@<walletId>` for each wallet added after it. Which wallet is open
 * is remembered in thanos.active_wallet (an id, not a secret), and each
 * wallet's public metadata (created / imported, its accounts' addresses)
 * in thanos.wallet_meta — see "Public per-wallet metadata" below. */
export interface StoredWallet { id: string; name: string; secret: string }
export interface WalletSet { wallets: StoredWallet[] }
export interface WalletInfo { id: string; name: string; kind: 'phrase' | 'key' }

const WALLET_SET_FORMAT = 'thanos.wallets/1';
export const FIRST_WALLET_ID = 'w0';
const STORAGE_KEY_ACTIVE_WALLET = 'thanos.active_wallet';
export const MAX_WALLETS = 10;
export const MAX_WALLET_NAME_LEN = 24;
const LOCKED_ERR = 'The wallet is locked — unlock it and try again.';
const SAVE_ERR = 'Couldn’t save the wallet — nothing was changed. Try again.';

function readActiveWalletId(): string {
  if (typeof window === 'undefined') return FIRST_WALLET_ID;
  return localStorage.getItem(STORAGE_KEY_ACTIVE_WALLET) || FIRST_WALLET_ID;
}
let currentWalletId = readActiveWalletId();

/** The wallet whose settings the per-wallet getters read (the open wallet). */
export function getCurrentWalletId(): string { return currentWalletId; }

/** localStorage key for a wallet's copy of a per-wallet setting (the open
 *  wallet's unless `id` names another). */
function nsKey(base: string, id = currentWalletId): string {
  return id === FIRST_WALLET_ID ? base : `${base}@${id}`;
}

export function parseWalletSet(plaintext: string): WalletSet {
  const t = plaintext.trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as { format?: unknown; wallets?: unknown };
      if (o.format === WALLET_SET_FORMAT && Array.isArray(o.wallets)) {
        const wallets = o.wallets.filter((w): w is StoredWallet =>
          !!w && typeof (w as StoredWallet).id === 'string' && typeof (w as StoredWallet).secret === 'string'
          && (w as StoredWallet).secret.trim() !== '',
        ).map(w => ({ id: w.id, name: typeof w.name === 'string' && w.name.trim() ? w.name.trim() : 'Wallet', secret: w.secret.trim() }));
        if (wallets.length) return { wallets };
      }
    } catch { /* not a wallet set — a plain secret */ }
  }
  return { wallets: [{ id: FIRST_WALLET_ID, name: 'Wallet 1', secret: t }] };
}

/** A set holding only the first wallet is written as its bare secret, the
 *  format every earlier version of the extension can still open. */
export function serializeWalletSet(set: WalletSet): string {
  if (set.wallets.length === 1 && set.wallets[0].id === FIRST_WALLET_ID) return set.wallets[0].secret;
  return JSON.stringify({ format: WALLET_SET_FORMAT, wallets: set.wallets });
}

const walletKind = (secret: string): WalletInfo['kind'] => (isPrivateKeyString(secret) ? 'key' : 'phrase');
export const walletInfo = (w: StoredWallet): WalletInfo => ({ id: w.id, name: w.name, kind: walletKind(w.secret) });

/** The wallet that's open (the remembered one if it's still in the set). */
export function currentWallet(set: WalletSet): StoredWallet {
  return set.wallets.find(w => w.id === currentWalletId) ?? set.wallets[0];
}

/** Open a wallet: per-wallet settings follow it, and it's remembered. The
 *  first wallet is the default when nothing is stored, so a single-wallet
 *  install never gains the key. */
export function selectWallet(set: WalletSet, id?: string): StoredWallet {
  const w = set.wallets.find(x => x.id === (id ?? readActiveWalletId())) ?? set.wallets[0];
  currentWalletId = w.id;
  if (typeof window !== 'undefined') {
    if (w.id === FIRST_WALLET_ID) localStorage.removeItem(STORAGE_KEY_ACTIVE_WALLET);
    else localStorage.setItem(STORAGE_KEY_ACTIVE_WALLET, w.id);
  }
  return w;
}

/** Normalise a secret so the same wallet imported twice compares equal. */
export function normaliseSecret(raw: string): string {
  const s = raw.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) return (s.startsWith('0x') ? s : `0x${s}`).toLowerCase();
  return s.toLowerCase().split(/\s+/).join(' ');
}

/* Wallet-set writes run one at a time: each re-reads the vault, so two
   overlapping changes (a double click, two popups) can't drop a wallet. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/** Re-encrypt new plaintext under the same password-derived key (same KDF
 *  and salt, fresh IV) — what adding/removing a wallet needs while unlocked. */
async function sealWithKey(vault: EncryptedVault, keyBytes: Uint8Array, plaintext: string): Promise<EncryptedVault> {
  const iv = randomBytes(12);
  const aes = await importAesKey(keyBytes);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource }, aes, new TextEncoder().encode(plaintext) as BufferSource,
  );
  return { ...vault, iv: bytesToHex(iv), ciphertext: bytesToHex(new Uint8Array(ct)) };
}

interface OpenSet { vault: EncryptedVault; set: WalletSet }
async function openSet(keyBytes: Uint8Array | null): Promise<OpenSet | null> {
  if (!keyBytes) return null;
  const vault = loadVault();
  if (!vault) return null;
  const pt = await openVaultWithKey(vault, keyBytes);
  return pt === null ? null : { vault, set: parseWalletSet(pt) };
}

/** Seal new plaintext, then read it back: unless the stored vault decrypts to
 *  exactly that plaintext, the previous vault is put back and false returned. */
async function writePlaintext(o: OpenSet, keyBytes: Uint8Array, plaintext: string): Promise<boolean> {
  try {
    saveVault(await sealWithKey(o.vault, keyBytes, plaintext));
    const back = loadVault();
    if (back && (await openVaultWithKey(back, keyBytes)) === plaintext) return true;
  } catch { /* restore below */ }
  try { saveVault(o.vault); } catch { /* storage refused both writes */ }
  return false;
}

export async function listWallets(keyBytes: Uint8Array): Promise<{ wallets: WalletInfo[]; activeId: string } | null> {
  const o = await openSet(keyBytes);
  if (!o) return null;
  return { wallets: o.set.wallets.map(walletInfo), activeId: currentWallet(o.set).id };
}

/** Add another wallet (a new or imported phrase, or a private key) to the
 *  vault and open it on its first account. The user holds its secret — it
 *  was just created and verified, or imported — so it counts as backed up.
 *  `origin` labels it in the wallet list (a private key is always imported). */
export async function addWallet(
  keyBytes: Uint8Array, rawSecret: string, name?: string, origin: WalletOrigin = 'imported',
): Promise<{ wallet: StoredWallet } | { error: string }> {
  return serial(async () => {
    const o = await openSet(keyBytes);
    if (!o) return { error: LOCKED_ERR };
    const secret = normaliseSecret(rawSecret);
    if (!secret) return { error: 'Enter a recovery phrase or a private key.' };
    const existing = o.set.wallets.find(w => normaliseSecret(w.secret) === secret);
    if (existing) return { error: `This wallet is already in Thanos (“${existing.name}”).` };
    if (o.set.wallets.length >= MAX_WALLETS) return { error: `Thanos holds up to ${MAX_WALLETS} wallets.` };
    const taken = new Set(o.set.wallets.map(w => w.name));
    let n = o.set.wallets.length + 1;
    while (taken.has(`Wallet ${n}`)) n++;
    let id = `w${bytesToHex(randomBytes(4))}`;
    while (id === FIRST_WALLET_ID || o.set.wallets.some(w => w.id === id)) id = `w${bytesToHex(randomBytes(4))}`;
    const wallet: StoredWallet = { id, name: name?.trim().slice(0, MAX_WALLET_NAME_LEN) || `Wallet ${n}`, secret };
    const set: WalletSet = { wallets: [...o.set.wallets, wallet] };
    if (!(await writePlaintext(o, keyBytes, serializeWalletSet(set)))) return { error: SAVE_ERR };
    forgetWalletSettings(id); // nothing should be there — never inherit stale settings
    setWalletOrigin(id, isPrivateKeyString(secret) ? 'imported' : origin);
    selectWallet(set, id);
    setSeedBackedUp(true);
    return { wallet };
  });
}

/** Open another wallet already in the vault. */
export async function switchWallet(keyBytes: Uint8Array, id: string): Promise<StoredWallet | null> {
  const o = await openSet(keyBytes);
  if (!o || !o.set.wallets.some(w => w.id === id)) return null;
  return selectWallet(o.set, id);
}

/** Open one account of any wallet in one step: that wallet (if it isn't the
 *  open one) and its account `idx` (if listed — else the wallet's own). */
export async function openAccount(keyBytes: Uint8Array, id: string, idx: number): Promise<StoredWallet | null> {
  const o = await openSet(keyBytes);
  const w = o?.set.wallets.find(x => x.id === id);
  if (!o || !w) return null;
  if (id !== currentWalletId) selectWallet(o.set, id);
  if (!isPrivateKeyString(w.secret) && getVisibleAccountIndices().includes(idx)) setActiveAccountIndex(idx);
  return w;
}

/** Add the next derived account to a recovery-phrase wallet — any wallet in
 *  the vault, not only the open one — and open the wallet on it. Indices
 *  are never reused (a removed account stays hidden at its index). */
export async function addAccountToWallet(
  keyBytes: Uint8Array, id: string,
): Promise<{ wallet: StoredWallet; idx: number } | { error: string }> {
  const o = await openSet(keyBytes);
  if (!o) return { error: LOCKED_ERR };
  const w = o.set.wallets.find(x => x.id === id);
  if (!w) return { error: 'That wallet is not in Thanos.' };
  if (isPrivateKeyString(w.secret)) return { error: 'This wallet was imported from a private key, so it has just the one account.' };
  if (readWalletAccounts(id).count >= MAX_ACCOUNTS) return { error: `A wallet holds up to ${MAX_ACCOUNTS} accounts.` };
  if (id !== currentWalletId) selectWallet(o.set, id);
  const idx = getAccountCount();
  setAccountCount(idx + 1);
  setActiveAccountIndex(idx);
  return { wallet: w, idx };
}

/** Rename a wallet. A lone first wallet is stored as its bare secret (no
 *  name), so it isn't renamed — names only tell several wallets apart, and
 *  the vault isn't rewritten until a second wallet is added. */
export async function renameWallet(keyBytes: Uint8Array, id: string, name: string): Promise<boolean> {
  return serial(async () => {
    const o = await openSet(keyBytes);
    const trimmed = name.trim().slice(0, MAX_WALLET_NAME_LEN);
    if (!o || !trimmed || !o.set.wallets.some(w => w.id === id)) return false;
    const set: WalletSet = { wallets: o.set.wallets.map(w => (w.id === id ? { ...w, name: trimmed } : w)) };
    if (set.wallets.length === 1 && set.wallets[0].id === FIRST_WALLET_ID) return false;
    return writePlaintext(o, keyBytes, serializeWalletSet(set));
  });
}

/** Remove one wallet — never the last (deleting that is clearVault) — with
 *  its settings and metadata, and open the first remaining one if it was open. */
export async function removeWallet(keyBytes: Uint8Array, id: string): Promise<{ next: StoredWallet } | { error: string }> {
  return serial(async () => {
    const o = await openSet(keyBytes);
    if (!o) return { error: LOCKED_ERR };
    if (o.set.wallets.length <= 1) return { error: 'This is the only wallet.' };
    const set: WalletSet = { wallets: o.set.wallets.filter(w => w.id !== id) };
    if (set.wallets.length === o.set.wallets.length) return { error: 'That wallet is not in Thanos.' };
    if (!(await writePlaintext(o, keyBytes, serializeWalletSet(set)))) return { error: SAVE_ERR };
    const next = currentWalletId === id ? selectWallet(set, set.wallets[0].id) : currentWallet(set);
    forgetWalletSettings(id);
    return { next };
  });
}

/** One wallet's secret — to derive the addresses of a wallet that isn't open
 *  and for the remove-wallet balance check (null when locked / unknown id). */
export async function readWalletSecret(keyBytes: Uint8Array | null, id: string): Promise<string | null> {
  const o = await openSet(keyBytes);
  return o?.set.wallets.find(w => w.id === id)?.secret ?? null;
}

/** The open wallet's backup flag, or another wallet's when `walletId` names it. */
export function isSeedBackedUp(walletId?: string): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(nsKey(STORAGE_KEYS.seedBackedUp, walletId ?? currentWalletId)) === '1';
}
export function setSeedBackedUp(backedUp: boolean): void {
  if (typeof window === 'undefined') return;
  if (backedUp) localStorage.setItem(nsKey(STORAGE_KEYS.seedBackedUp), '1');
  else          localStorage.removeItem(nsKey(STORAGE_KEYS.seedBackedUp));
}

/* ─── Multi-account derivation index ────────────────────────────────
   A wallet's accounts share its seed — different accounts are different
   HD-path indices: m/44'/60'/0'/0/{idx} — and each wallet in the vault
   has its own copy of these settings (nsKey above). Storage tracks
   the *active* index (the one the popup signs from) and the user's
   accountCount (how many "Account N" rows to show in the switcher).
   On a fresh install both default to 0 / 1.
*/
/* ─── Private-key wallets ────────────────────────────────────────────
 * A wallet imported from a raw key stores the 0x-hex string where a
 * mnemonic wallet stores space-separated words. `seed` in the popup is
 * always string[]: [word, …] for HD, ['0x…64'] for a PK wallet. A PK
 * wallet is EVM-only and has exactly one account. */
export function isPrivateKeyString(s: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(s.trim());
}
export function isPrivateKeyWallet(seed: string[]): boolean {
  return seed.length === 1 && isPrivateKeyString(seed[0] ?? '');
}

const STORAGE_KEY_ACTIVE_IDX = 'thanos.active_account_idx';
const STORAGE_KEY_ACCT_COUNT = 'thanos.account_count';
export const MAX_ACCOUNTS = 10;

/** A wallet's copy of an integer setting, clamped to [min, max]. */
function readIntSetting(base: string, id: string, fallback: number, min: number, max: number): number {
  if (typeof window === 'undefined') return fallback;
  const n = Number.parseInt(localStorage.getItem(nsKey(base, id)) ?? String(fallback), 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export function getActiveAccountIndex(): number {
  return readIntSetting(STORAGE_KEY_ACTIVE_IDX, currentWalletId, 0, 0, MAX_ACCOUNTS - 1);
}

export function setActiveAccountIndex(idx: number): void {
  if (typeof window === 'undefined') return;
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_ACCOUNTS) return;
  localStorage.setItem(nsKey(STORAGE_KEY_ACTIVE_IDX), String(idx));
}

export function getAccountCount(): number {
  return readIntSetting(STORAGE_KEY_ACCT_COUNT, currentWalletId, 1, 1, MAX_ACCOUNTS);
}

export function setAccountCount(n: number): void {
  if (typeof window === 'undefined') return;
  if (!Number.isInteger(n) || n < 1 || n > MAX_ACCOUNTS) return;
  localStorage.setItem(nsKey(STORAGE_KEY_ACCT_COUNT), String(n));
}

/* ─── Account names (rename) ─────────────────────────────────────────────
   Same storage key + 24-char cap as apps/mobile/lib/accounts.ts and web, so a
   name set on one client reads identically on another. */
const STORAGE_KEY_ACCT_NAMES = 'thanos.account_names';
export const MAX_ACCOUNT_NAME_LEN = 24;

function readNames(id = currentWalletId): Record<number, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(nsKey(STORAGE_KEY_ACCT_NAMES, id));
    if (!raw) return {};
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

/** Display name — the user's custom name, else "Account N". */
export function getAccountName(idx: number): string {
  return readNames()[idx]?.trim() || `Account ${idx + 1}`;
}

/** The custom name only (null when the account uses the default). */
export function getCustomAccountName(idx: number): string | null {
  return readNames()[idx] ?? null;
}

/** Set (or clear, with an empty string) an account's custom name. */
export function setAccountName(idx: number, name: string): void {
  if (typeof window === 'undefined') return;
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_ACCOUNTS) return;
  const names = readNames();
  const trimmed = name.trim().slice(0, MAX_ACCOUNT_NAME_LEN);
  if (trimmed) names[idx] = trimmed;
  else delete names[idx];
  localStorage.setItem(nsKey(STORAGE_KEY_ACCT_NAMES), JSON.stringify(names));
}

/* ─── Account removal ────────────────────────────────────────────────────
   Accounts are HD-path indices, so an account CANNOT be spliced out: removing
   index 1 of 0..2 would slide index 2 down and silently change that account's
   address — funds would look like they vanished. A removed account is instead
   recorded in a HIDDEN set; every index keeps deriving the same address
   forever and the account simply stops being listed. */
const STORAGE_KEY_ACCT_HIDDEN = 'thanos.account_hidden';

function readHidden(id: string): number[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(nsKey(STORAGE_KEY_ACCT_HIDDEN, id));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    return arr.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < MAX_ACCOUNTS);
  } catch { return []; }
}

export function getHiddenAccounts(): number[] {
  return readHidden(currentWalletId);
}

export function isAccountHidden(idx: number): boolean {
  return getHiddenAccounts().includes(idx);
}

function visibleOf(count: number, hidden: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (!hidden.includes(i)) out.push(i);
  return out.length ? out : [0];
}

/** Indices the UI should list. Never empty — a wallet always keeps one. */
export function getVisibleAccountIndices(): number[] {
  return visibleOf(getAccountCount(), getHiddenAccounts());
}

/** Hide (delete) an account. Refuses the last visible one. Balance checks
 *  live in the UI, the only layer that can price what the account holds. */
export function hideAccount(idx: number): boolean {
  if (typeof window === 'undefined') return false;
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_ACCOUNTS) return false;
  const visible = getVisibleAccountIndices();
  if (visible.length <= 1 || !visible.includes(idx)) return false;
  const hidden = getHiddenAccounts();
  if (!hidden.includes(idx)) hidden.push(idx);
  localStorage.setItem(nsKey(STORAGE_KEY_ACCT_HIDDEN), JSON.stringify(hidden));
  if (getActiveAccountIndex() === idx) {
    setActiveAccountIndex(getVisibleAccountIndices()[0] ?? 0);
  }
  return true;
}

/* ─── Every wallet's accounts ────────────────────────────────────────── */

/** A wallet's accounts as the wallet list shows them. */
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

/** Any wallet's accounts, read from its own copy of the settings — the
 *  open wallet's or another's — without opening it. */
export function readWalletAccounts(walletId: string): WalletAccounts {
  const count = readIntSetting(STORAGE_KEY_ACCT_COUNT, walletId, 1, 1, MAX_ACCOUNTS);
  const visible = visibleOf(count, readHidden(walletId));
  const idx = readIntSetting(STORAGE_KEY_ACTIVE_IDX, walletId, 0, 0, MAX_ACCOUNTS - 1);
  return { active: visible.includes(idx) ? idx : visible[0], visible, count, names: readNames(walletId) };
}

/* ─── Public per-wallet metadata ──────────────────────────────────────────
 * thanos.wallet_meta = { [walletId]: { origin?, addrs?: { [idx]: '0x…' } } }
 * — the same key and shape as the phone (apps/mobile/lib/accounts.ts). Never
 * a secret: how the wallet came in (created in Thanos / imported) and its
 * accounts' derived 0x addresses, so the wallet list can show every wallet's
 * accounts without decrypting and re-deriving each one. */
export type WalletOrigin = 'created' | 'imported';
interface WalletMeta { origin?: WalletOrigin; addrs?: Record<number, string> }
const STORAGE_KEY_WALLET_META = 'thanos.wallet_meta';

const isAddr = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/.test(v);

function readMeta(): Record<string, WalletMeta> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY_WALLET_META);
    if (!raw) return {};
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
function writeMeta(meta: Record<string, WalletMeta>): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY_WALLET_META, JSON.stringify(meta)); } catch { /* best-effort cache */ }
}

/** Created in Thanos or imported — unknown for wallets from before this was recorded. */
export function getWalletOrigin(walletId: string): WalletOrigin | undefined {
  return readMeta()[walletId]?.origin;
}
export function setWalletOrigin(walletId: string, origin: WalletOrigin): void {
  const meta = readMeta();
  if (meta[walletId]?.origin === origin) return;
  meta[walletId] = { ...meta[walletId], origin };
  writeMeta(meta);
}

/** A wallet's known account addresses (0x) by HD index. */
export function getWalletAddresses(walletId: string): Record<number, string> {
  return { ...readMeta()[walletId]?.addrs };
}
/** Record derived account addresses (merged into what's known; public data —
 *  anything that isn't a 0x address is dropped). */
export function setWalletAddresses(walletId: string, addrs: Record<number, string>): void {
  const meta = readMeta();
  const known = meta[walletId]?.addrs ?? {};
  const next = { ...known };
  let changed = false;
  for (const [k, v] of Object.entries(addrs)) {
    const i = Number(k);
    if (Number.isInteger(i) && i >= 0 && i < MAX_ACCOUNTS && isAddr(v) && known[i] !== v) { next[i] = v; changed = true; }
  }
  if (!changed) return;
  meta[walletId] = { ...meta[walletId], addrs: next };
  writeMeta(meta);
}

/** Settings each wallet keeps its own copy of (nsKey). */
const PER_WALLET_KEYS = [
  STORAGE_KEYS.seedBackedUp, STORAGE_KEY_ACTIVE_IDX, STORAGE_KEY_ACCT_COUNT, STORAGE_KEY_ACCT_NAMES, STORAGE_KEY_ACCT_HIDDEN,
];

/** Drop a removed wallet's settings and metadata. */
function forgetWalletSettings(walletId: string): void {
  if (typeof window === 'undefined') return;
  for (const base of PER_WALLET_KEYS) localStorage.removeItem(nsKey(base, walletId));
  const meta = readMeta();
  if (walletId in meta) {
    delete meta[walletId];
    writeMeta(meta);
  }
}

/** Every wallet deleted (clearVault): drop the added wallets' settings and
 *  all wallet metadata. The first wallet's own keys stay as they always were. */
function forgetAddedWallets(): void {
  if (typeof window === 'undefined') return;
  const added: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && PER_WALLET_KEYS.some(base => k.startsWith(`${base}@`))) added.push(k);
  }
  for (const k of added) localStorage.removeItem(k);
  localStorage.removeItem(STORAGE_KEY_WALLET_META);
}

/** Erase every wallet from this browser. */
export function clearVault(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEYS.vault);
  localStorage.removeItem(STORAGE_KEYS.hasVault);
  localStorage.removeItem(STORAGE_KEYS.seedBackedUp);
  localStorage.removeItem(STORAGE_KEY_ACTIVE_WALLET);
  currentWalletId = FIRST_WALLET_ID;
  forgetAddedWallets();
  localStorage.removeItem(STORAGE_KEYS.legacyMnemonic);
  localStorage.removeItem(STORAGE_KEYS.legacyPassword);
  localStorage.removeItem(STORAGE_KEYS.legacyUnlocked);
  clearSessionKey();
}

/* ─── Session key cache (refresh persistence, NOT cold-open) ────────────── */
export function cacheSessionKey(key: Uint8Array): void {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(STORAGE_KEYS.sessionKey, bytesToHex(key));
}
export function getSessionKey(): Uint8Array | null {
  if (typeof window === 'undefined') return null;
  const hex = sessionStorage.getItem(STORAGE_KEYS.sessionKey);
  if (!hex) return null;
  try { return hexToBytes(hex); } catch { return null; }
}
export function clearSessionKey(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(STORAGE_KEYS.sessionKey);
}

/* ─── Migration from plaintext (legacy) ─────────────────────────────────── */

/** Returns true if the legacy plaintext keys are still present. */
export function hasLegacyPlaintext(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(STORAGE_KEYS.legacyMnemonic) !== null
      && localStorage.getItem(STORAGE_KEYS.legacyPassword) !== null;
}

/**
 * One-shot upgrade from the old plaintext storage scheme to an encrypted vault.
 * No prompt required — the password was already in localStorage. Once the
 * vault exists, the plaintext keys are wiped.
 */
export async function migrateLegacyPlaintext(): Promise<{ ok: boolean; key?: Uint8Array }> {
  if (typeof window === 'undefined') return { ok: false };
  const mnemonic = localStorage.getItem(STORAGE_KEYS.legacyMnemonic);
  const password = localStorage.getItem(STORAGE_KEYS.legacyPassword);
  if (!mnemonic || !password) return { ok: false };

  const vault = await createVault(mnemonic, password);
  saveVault(vault);

  // Derive the key once more so the caller can session-cache it (matches the
  // previous "auto-unlocked on refresh" behaviour for users mid-migration).
  const opened = await openVault(vault, password);

  // Wipe plaintext.
  localStorage.removeItem(STORAGE_KEYS.legacyMnemonic);
  localStorage.removeItem(STORAGE_KEYS.legacyPassword);
  localStorage.removeItem(STORAGE_KEYS.legacyUnlocked);

  return { ok: true, key: opened?.key };
}

/** Exported for tests / outside callers. */
export const VAULT_STORAGE_KEYS = STORAGE_KEYS;
