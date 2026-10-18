/**
 * "Wallets & accounts" — every wallet in the vault as a card with its
 * accounts under it, the phone's account sheet (apps/mobile/App.tsx,
 * client 2026-10-17) on the desktop. Sections: wallets created in Thanos,
 * the first wallet of an install from before origins were recorded, imported
 * recovery phrases, imported private keys. Clicking any account of any
 * wallet opens that wallet on that account; "+ Add wallet" creates or
 * imports another one next to the others under the same password.
 *
 * Vault and settings live in vault.ts; App (main.tsx) owns the open wallet
 * and runs the actions, this file only draws them.
 */
import React, { useEffect, useRef, useState } from 'react';
import { HDNodeWallet, Wallet } from 'ethers';
import { ModalPortal } from './components/ModalPortal';
import {
  FIRST_WALLET_ID, MAX_ACCOUNTS, MAX_WALLETS,
  getWalletOrigin, getWalletAddresses, setWalletAddresses,
  readWalletAccounts, readWalletSecret, seedWords, isPrivateKeyWallet,
  getAccountName, getVisibleAccountIndices,
  type WalletInfo, type WalletAccounts,
} from './vault';

export type AddWalletStart = 'create' | 'phrase' | 'privateKey';

/* ─── Sections and labels — same as the phone ─────────────────────────── */
const WALLET_GROUPS = [
  { key: 'created',  title: 'Created in Thanos' },
  { key: 'phrase',   title: 'Recovery phrase' },
  { key: 'imported', title: 'Imported · recovery phrase' },
  { key: 'key',      title: 'Imported · private key' },
] as const;
type WalletGroupKey = (typeof WALLET_GROUPS)[number]['key'];
/** A phrase wallet whose origin was never recorded (an existing install's
 *  first wallet) can't be placed, so it sits under "Recovery phrase". */
function walletGroupOf(w: WalletInfo): WalletGroupKey {
  return w.kind === 'key' ? 'key' : (getWalletOrigin(w.id) ?? 'phrase');
}
export function walletOriginLabel(w: WalletInfo): string {
  return { created: 'Created', phrase: 'Recovery phrase', imported: 'Imported phrase', key: 'Private key' }[walletGroupOf(w)];
}

/* ─── Wallet & account icons — the phone's palette ─────────────────────────
   A wallet's colour comes from its id (the first wallet keeps Thanos blue,
   two wallets never share one); an account's from its wallet's colour + its
   HD index. Saturated two-stop gradients that carry a white glyph. */
const IDENTITY_PALETTE: ReadonlyArray<readonly [string, string]> = [
  ['#4f86f7', '#2a5bd7'], // blue
  ['#f0782a', '#c4480f'], // orange
  ['#12a37a', '#08745a'], // emerald
  ['#e0509b', '#b0256f'], // pink
  ['#9a6cf6', '#6d3fe0'], // violet
  ['#c99312', '#94640a'], // gold
  ['#1597b8', '#0b6a8a'], // cyan
  ['#ec4a62', '#b81d3c'], // rose
  ['#6b6ef2', '#4338ca'], // indigo
  ['#139c8d', '#0b6e66'], // teal
];
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** Palette slot per wallet id, in vault order. */
function walletHues(ids: string[]): Record<string, number> {
  const n = IDENTITY_PALETTE.length;
  const out: Record<string, number> = {};
  const used = new Set<number>();
  for (const id of ids) {
    let h = id === FIRST_WALLET_ID ? 0 : fnv1a(id) % n;
    for (let k = 0; k < n && used.has(h); k++) h = (h + 1) % n;
    used.add(h);
    out[id] = h;
  }
  return out;
}
const accountHue = (walletHue: number, idx: number) => (walletHue + idx) % IDENTITY_PALETTE.length;
/** "Account 3" → "A3", "Trading bot" → "TB", "Savings" → "S". */
function accountInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const pick = (w: string) => (/^\d+$/.test(w) ? w : w[0]);
  return words.length === 1 ? pick(words[0]).toUpperCase().slice(0, 2) : (pick(words[0]) + pick(words[1])).toUpperCase().slice(0, 3);
}

function IdentityIcon({ hue, size, wallet, label }: { hue: number; size: number; wallet?: WalletInfo['kind']; label?: string }) {
  const [from, to] = IDENTITY_PALETTE[((hue % IDENTITY_PALETTE.length) + IDENTITY_PALETTE.length) % IDENTITY_PALETTE.length];
  const glyph = Math.round(size * 0.48);
  return (
    <span className="wp-ident" aria-hidden style={{
      width: size, height: size, borderRadius: wallet ? Math.round(size * 0.3) : '50%',
      background: `linear-gradient(135deg, ${from}, ${to})`,
      fontSize: Math.round(size * ((label ?? '').length > 2 ? 0.3 : 0.36)),
    }}>
      {wallet === 'key' ? (
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>
      ) : wallet ? (
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/></svg>
      ) : label}
    </span>
  );
}

/** EVM addresses of a wallet's accounts (m/44'/60'/0'/0/{idx}; a private key
 *  is its one account). One seed computation for all of them. */
export function deriveAccountAddresses(words: string[], indices: number[]): Record<number, string> {
  const out: Record<number, string> = {};
  try {
    if (isPrivateKeyWallet(words)) { out[0] = new Wallet(words[0].trim()).address; return out; }
    if (!words.length || !indices.length) return out;
    const base = HDNodeWallet.fromPhrase(words.join(' '), undefined, "m/44'/60'/0'/0");
    for (const i of indices) out[i] = base.deriveChild(i).address;
  } catch { /* not derivable — the row says so */ }
  return out;
}

const Glyph = {
  pencil: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>,
  trash: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>,
  check: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>,
  plus: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>,
  dots: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>,
  back: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>,
  chev: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>,
  sparkles: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/></svg>,
  key: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>,
  shield: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
};

export interface WalletsPanelProps {
  /** Every wallet in the vault (empty until listed — the open one is shown). */
  wallets: WalletInfo[];
  activeWalletId: string;
  /** The open wallet's secret as words (its addresses derive from it). */
  walletSeed: string[];
  /** The open wallet's active account and provisioned count (live state). */
  activeIdx: number;
  accountCount: number;
  /** Bumped by App whenever account settings change, to re-read them. */
  acctTick: number;
  busy: boolean;
  /** A status / error line from the last action. */
  msg: string | null;
  /** 0x → the short litho1 form shown in the rows (main.tsx's helpers). */
  formatAddr: (evm: string) => string;
  onClose: () => void;
  onOpenAccount: (walletId: string, idx: number) => void;
  onOpenWallet: (walletId: string) => void;
  onAddAccount: (walletId: string) => void;
  onRenameAccount: (idx: number) => void;
  onDeleteAccount: (idx: number) => void;
  onRenameWallet: (walletId: string) => void;
  onRemoveWallet: (walletId: string) => void;
  onAddWallet: (start: AddWalletStart) => void;
}

export function WalletsPanel(p: WalletsPanelProps) {
  const [view, setView] = useState<'list' | 'add'>('list');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [, setAddrTick] = useState(0);
  const failed = useRef<Record<string, Set<number>>>({});

  const openPk = isPrivateKeyWallet(p.walletSeed);
  const shown: WalletInfo[] = p.wallets.length ? p.wallets
    : [{ id: p.activeWalletId, name: 'Wallet 1', kind: openPk ? 'key' : 'phrase' }];
  const hues = walletHues(shown.map(w => w.id));
  // The open wallet from live state; the others from their stored settings.
  const infoOf = (w: WalletInfo): WalletAccounts => {
    if (w.id !== p.activeWalletId) return readWalletAccounts(w.id);
    const pk = w.kind === 'key';
    return { active: pk ? 0 : p.activeIdx, visible: pk ? [0] : getVisibleAccountIndices(), count: pk ? 1 : p.accountCount, names: {} };
  };

  /* Addresses: cached in the public wallet metadata; any missing are derived
     once the panel is up — the open wallet from its seed, the others from
     the unlocked vault — one wallet at a time, rows say "Loading address…"
     until theirs land. */
  const walletKeyList = shown.map(w => `${w.id}:${w.kind}`).join(',');
  useEffect(() => {
    let cancel = false;
    const timer = setTimeout(() => {
      void (async () => {
        for (const w of shown) {
          if (cancel) return;
          const want = w.kind === 'key' ? [0] : infoOf(w).visible;
          const known = getWalletAddresses(w.id);
          const bad = failed.current[w.id] ?? new Set<number>();
          const missing = want.filter(i => !known[i] && !bad.has(i));
          if (!missing.length) continue;
          const words = w.id === p.activeWalletId ? p.walletSeed : seedWords((await readWalletSecret(w.id)) ?? '');
          if (cancel) return;
          const got = deriveAccountAddresses(words, missing);
          setWalletAddresses(w.id, got);
          for (const i of missing) if (!got[i]) bad.add(i);
          failed.current[w.id] = bad;
          setAddrTick(t => t + 1);
          await new Promise(r => setTimeout(r, 16)); // let the panel paint between wallets
        }
      })();
    }, 40);
    return () => { cancel = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run when the wallets, the open one or its accounts change
  }, [walletKeyList, p.activeWalletId, p.walletSeed, p.acctTick, p.accountCount]);

  const renderCard = (w: WalletInfo) => {
    const open = w.id === p.activeWalletId;
    const pk = w.kind === 'key';
    const hue = hues[w.id] ?? 0;
    const group = walletGroupOf(w);
    const info = infoOf(w);
    const addrs = getWalletAddresses(w.id);
    const nameOf = (i: number) => (open ? getAccountName(i) : info.names[i] || `Account ${i + 1}`);
    const rows = pk ? [0] : [info.active, ...info.visible.filter(i => i !== info.active)];
    const lastAccount = info.visible.length <= 1;
    const several = shown.length > 1;
    return (
      <div key={w.id} className={`wp-card${open ? ' wp-card-open' : ''}`}>
        {/* The wallet: icon, name, type badge, account count, "…" */}
        <div
          className={`wp-wallet-row${open ? '' : ' wp-clickable'}`}
          role={open ? undefined : 'button'}
          tabIndex={open ? undefined : 0}
          aria-label={open ? undefined : `Open ${w.name}, ${walletOriginLabel(w)}`}
          title={open ? undefined : `Open ${w.name}`}
          onClick={() => { if (!open) p.onOpenWallet(w.id); }}
          onKeyDown={e => { if (!open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); p.onOpenWallet(w.id); } }}
        >
          <IdentityIcon hue={hue} size={34} wallet={w.kind}/>
          <div className="wp-wallet-text">
            <div className="wp-wallet-name">{w.name}</div>
            <div className="wp-wallet-meta">
              <span className={`wp-badge wp-badge-${group}`}>{walletOriginLabel(w)}</span>
              {!pk && <span>{info.visible.length} {info.visible.length === 1 ? 'account' : 'accounts'}</span>}
              {open && several && <span className="wp-open-tag">Open</span>}
            </div>
          </div>
          <div className="wp-menu-anchor">
            <button
              type="button" className="wp-icon-btn" aria-label={`${w.name} options`} aria-expanded={menuFor === w.id}
              onClick={e => { e.stopPropagation(); setMenuFor(m => (m === w.id ? null : w.id)); }}
            >{Glyph.dots}</button>
            {menuFor === w.id && (
              <div className="wp-popover" role="menu" onClick={e => e.stopPropagation()}>
                {several && (
                  <button type="button" role="menuitem" className="wp-popover-item" onClick={() => { setMenuFor(null); p.onRenameWallet(w.id); }}>
                    {Glyph.pencil} Rename
                  </button>
                )}
                <button type="button" role="menuitem" className="wp-popover-item wp-danger" onClick={() => { setMenuFor(null); p.onRemoveWallet(w.id); }}>
                  {Glyph.trash} {several ? 'Remove' : 'Delete wallet'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Its accounts — the wallet's active one first. Clicking one opens
            this wallet on that account in one step. */}
        {rows.map(i => {
          const a = addrs[i];
          const on = open && i === (pk ? 0 : p.activeIdx);
          const tag = a ? p.formatAddr(a) : failed.current[w.id]?.has(i) ? 'Address unavailable' : 'Loading address…';
          const name = nameOf(i);
          return (
            <div
              key={i}
              className={`wp-account-row${on ? ' wp-account-on' : ''}`}
              role="button" tabIndex={0}
              aria-label={on ? `${name} (active)` : `Open ${name} in ${w.name}`}
              onClick={() => p.onOpenAccount(w.id, i)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onOpenAccount(w.id, i); } }}
            >
              <IdentityIcon hue={accountHue(hue, i)} size={28} label={accountInitials(name)}/>
              <div className="wp-account-text">
                <div className="wp-account-name">{name}</div>
                <div className="wp-account-addr" title={a ? p.formatAddr(a) : undefined}>{tag}</div>
              </div>
              {on && <span className="wp-tick" aria-hidden>{Glyph.check}</span>}
              {/* Rename / delete for the open wallet's accounts (a wallet must
                  keep one account — delete is dimmed on the last). */}
              {open && (
                <button type="button" className="wp-icon-btn" title="Rename account" aria-label={`Rename ${name}`}
                  onClick={e => { e.stopPropagation(); p.onRenameAccount(i); }}>{Glyph.pencil}</button>
              )}
              {open && !pk && (
                <button type="button" className="wp-icon-btn wp-danger" disabled={lastAccount || p.busy}
                  title={lastAccount ? 'Your wallet must keep at least one account' : 'Delete account'}
                  aria-label={`Delete ${name}`}
                  onClick={e => { e.stopPropagation(); if (!lastAccount) p.onDeleteAccount(i); }}>{Glyph.trash}</button>
              )}
            </div>
          );
        })}

        {/* "+ Add account" under every recovery-phrase wallet: the next
            derived account of THIS wallet, opened. A private key has one. */}
        {!pk && info.count < MAX_ACCOUNTS && (
          <button type="button" className="wp-add-account" disabled={p.busy} onClick={() => p.onAddAccount(w.id)}>
            {Glyph.plus} Add account
          </button>
        )}
      </div>
    );
  };

  const full = shown.length >= MAX_WALLETS;
  return (
    <ModalPortal>
      <div className="modal-backdrop" onClick={p.onClose}>
        <div className="modal-box wp-box" role="dialog" aria-modal="true" aria-label={view === 'list' ? 'Wallets and accounts' : 'Add wallet'}
          onClick={e => { e.stopPropagation(); setMenuFor(null); }}>
          <div className="modal-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              {view === 'add' && (
                <button type="button" className="wp-icon-btn" aria-label="Back to wallets and accounts" onClick={() => setView('list')}>{Glyph.back}</button>
              )}
              <span className="modal-title">{view === 'list' ? 'Wallets & accounts' : 'Add wallet'}</span>
              {p.busy && <span className="wp-spinner" aria-label="Working"/>}
            </div>
            <button className="modal-close" onClick={p.onClose} aria-label="Close">✕</button>
          </div>

          <div className="modal-body wp-body">
            {p.msg && <div className="wp-msg" role="status">{p.msg}</div>}

            {view === 'list' && WALLET_GROUPS.map(g => {
              const list = shown.filter(w => walletGroupOf(w) === g.key);
              if (!list.length) return null;
              return (
                <section key={g.key} className="wp-section">
                  <h3 className="wp-section-title">{g.title}</h3>
                  {list.map(renderCard)}
                </section>
              );
            })}

            {/* Add wallet — a new phrase (with the usual backup and verify
                steps) or an import, kept next to the others. */}
            {view === 'add' && (
              <>
                <p className="wp-add-intro">
                  Your current wallets stay — switch between them here. Each wallet has its own recovery phrase (or key) and accounts, all unlocked with your Thanos password.
                </p>
                {([
                  { start: 'create', title: 'Create new wallet', sub: 'A new recovery phrase to write down and verify', icon: Glyph.sparkles },
                  { start: 'phrase', title: 'Import recovery phrase', sub: '12–24 words · full multi-chain wallet', icon: Glyph.key },
                  { start: 'privateKey', title: 'Import private key', sub: 'Single EVM account · no BTC/SOL/Cosmos', icon: Glyph.shield },
                ] as const).map(o => (
                  <button key={o.start} type="button" className="wp-option" onClick={() => p.onAddWallet(o.start)}>
                    <span className="wp-option-icon">{o.icon}</span>
                    <span className="wp-option-text">
                      <span className="wp-option-title">{o.title}</span>
                      <span className="wp-option-sub">{o.sub}</span>
                    </span>
                    <span className="wp-option-chev">{Glyph.chev}</span>
                  </button>
                ))}
              </>
            )}
          </div>

          {view === 'list' && (
            <div className="wp-footer">
              <button type="button" className="wp-add-wallet" disabled={p.busy}
                title={full ? `Thanos holds up to ${MAX_WALLETS} wallets` : undefined}
                onClick={() => (full ? undefined : setView('add'))}
                aria-disabled={full}>
                {Glyph.plus} {full ? `Wallet limit reached (${MAX_WALLETS})` : 'Add wallet'}
              </button>
            </div>
          )}
        </div>
      </div>
    </ModalPortal>
  );
}

/** Rename an account or a wallet. (window.prompt doesn't exist in Electron —
 *  it throws — so the old prompt-based rename never opened.) */
export function RenameDialog({ title, sub, initial, placeholder, maxLength, allowEmpty, onSave, onClose }: {
  title: string; sub: string; initial: string; placeholder: string; maxLength: number;
  /** Accounts: empty resets to "Account N". Wallets: a name is required. */
  allowEmpty: boolean;
  onSave: (name: string) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ok = allowEmpty || draft.trim() !== '';
  const save = () => { if (ok) { onSave(draft); onClose(); } };
  return (
    <ModalPortal>
      <div className="modal-backdrop" style={{ zIndex: 260 }} onClick={onClose}>
        <div className="modal-box" style={{ width: 360 }} role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <span className="modal-title">{title}</span>
            <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
          </div>
          <div className="modal-body" style={{ gap: 12 }}>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>{sub}</p>
            <input
              className="field-input" autoFocus value={draft} maxLength={maxLength} placeholder={placeholder}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onClose(); }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn-outline" style={{ flex: 1, height: 40 }} onClick={onClose}>Cancel</button>
              <button type="button" className="btn-primary" style={{ flex: 1, height: 40 }} disabled={!ok} onClick={save}>Save</button>
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
