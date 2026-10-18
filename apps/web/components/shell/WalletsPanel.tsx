'use client';
/**
 * Wallets & accounts — every wallet in the vault, each with its accounts,
 * in one panel (the phone app's account sheet, apps/mobile/App.tsx
 * renderWalletCard / sheetView, client 2026-10-17).
 *
 *   - Sections: created in Thanos, the first wallet whose origin was never
 *     recorded ("Recovery phrase"), imported phrases, imported private keys.
 *   - A card per wallet: icon, name, type badge, account count and a "…"
 *     with Rename (several wallets) and Remove (the last wallet's runs the
 *     full delete flow).
 *   - Its accounts under it by litho1… address, the wallet's active one
 *     first; the open wallet's active account is ticked. Tapping any
 *     account of any wallet opens that wallet on that account.
 *   - "+ Add account" under every recovery-phrase wallet (a private key has
 *     one account); "+ Add wallet" → create / import phrase / import key.
 *
 * The panel only renders and reports taps; AppShell owns the vault calls,
 * the dialogs and the open wallet's live state.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  X, Plus, Check, Pencil, Trash2, Ellipsis, ChevronLeft, ChevronRight,
  Wallet as WalletGlyph, KeyRound, Sparkles, ScrollText,
} from 'lucide-react';
import {
  MAX_ACCOUNTS, MAX_WALLETS, FIRST_WALLET_ID,
  getAccountName, getWalletOrigin, getWalletAddresses, setWalletAddresses,
  readWalletAccounts, readWalletSecret,
  type WalletAccounts, type WalletInfo,
} from '../../lib/vault';
import { toLithoForm, shortAddress } from '../../lib/address';
import { deriveWalletAddresses } from '../../lib/account-discovery';
import type { AddWalletMode } from '../onboarding';
import s from './WalletsPanel.module.css';

/* ─── Sections and labels (same as the phone) ─────────────────────────── */
export const WALLET_GROUPS = [
  { key: 'created',  title: 'Created in Thanos' },
  { key: 'phrase',   title: 'Recovery phrase' },
  { key: 'imported', title: 'Imported · recovery phrase' },
  { key: 'key',      title: 'Imported · private key' },
] as const;
type WalletGroupKey = (typeof WALLET_GROUPS)[number]['key'];

/** A phrase wallet from before the origin was recorded (an existing
 *  install's first wallet) can't be placed, so it sits under "Recovery phrase". */
export function walletGroupOf(w: WalletInfo): WalletGroupKey {
  return w.kind === 'key' ? 'key' : (getWalletOrigin(w.id) ?? 'phrase');
}
export function walletOriginLabel(w: WalletInfo): string {
  return { created: 'Created', phrase: 'Recovery phrase', imported: 'Imported phrase', key: 'Private key' }[walletGroupOf(w)];
}
const BADGE_CLASS: Record<WalletGroupKey, string> = {
  created: s.badgeCreated, phrase: s.badgePhrase, imported: s.badgeImported, key: s.badgeKey,
};

/* ─── Wallet & account colours (same palette and rules as the phone) ──── */
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
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** Palette slot per wallet id, in vault order: the first wallet keeps
 *  Thanos blue, and two wallets never share a colour. */
export function walletHues(ids: string[]): Record<string, number> {
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
export const accountHue = (walletHue: number, idx: number) => (walletHue + idx) % IDENTITY_PALETTE.length;

/** "Account 3" → "A3", "Trading bot" → "TB", "Savings" → "S". */
export function accountInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const pick = (w: string) => (/^\d+$/.test(w) ? w : w[0]);
  return words.length === 1 ? pick(words[0]).toUpperCase().slice(0, 2) : (pick(words[0]) + pick(words[1])).toUpperCase().slice(0, 3);
}

/** A wallet (rounded square, wallet / key glyph) or an account (circle,
 *  initials) in its palette colour. */
export function IdentityIcon({ hue, size = 34, wallet, label }: {
  hue: number; size?: number; wallet?: WalletInfo['kind']; label?: string;
}) {
  const [a, b] = IDENTITY_PALETTE[hue % IDENTITY_PALETTE.length];
  const Glyph = wallet === 'key' ? KeyRound : WalletGlyph;
  return (
    <span
      aria-hidden
      className={s.identity}
      style={{
        width: size, height: size,
        borderRadius: wallet ? Math.round(size * 0.3) : '50%',
        background: `linear-gradient(135deg, ${a}, ${b})`,
        fontSize: Math.round(size * (label && label.length > 2 ? 0.3 : 0.36)),
      }}
    >
      {wallet ? <Glyph size={Math.round(size * 0.5)} strokeWidth={2.2}/> : label}
    </span>
  );
}

/** The short litho1… form a row shows (Lithosphere is litho1 everywhere). */
const rowAddress = (evm: string | undefined): string | null =>
  evm && /^0x[0-9a-fA-F]{40}$/.test(evm) && !/^0x0{40}$/.test(evm) ? shortAddress(toLithoForm(evm)) : null;

/* ─── The panel ───────────────────────────────────────────────────────── */

/** The open wallet, from AppShell's live state. */
export interface OpenWalletState {
  id: string;
  kind: WalletInfo['kind'];
  activeIdx: number;
  visible: number[];
  count: number;
  /** 0x address per HD index — for a key wallet, its one address at 0. */
  addresses: string[];
}

export function WalletsPanel({
  wallets, openWallet, busy, onClose,
  onOpenAccount, onOpenWallet, onAddAccount, onRenameAccount, onDeleteAccount,
  onRenameWallet, onRemoveWallet, onAddWallet,
}: {
  wallets: WalletInfo[];
  openWallet: OpenWalletState;
  /** A wallet / account action is running (shows a spinner, blocks taps). */
  busy: boolean;
  onClose: () => void;
  onOpenAccount: (walletId: string, idx: number) => void;
  onOpenWallet: (walletId: string) => void;
  onAddAccount: (walletId: string) => void;
  onRenameAccount: (idx: number) => void;
  onDeleteAccount: (idx: number) => void;
  onRenameWallet: (walletId: string) => void;
  onRemoveWallet: (walletId: string) => void;
  onAddWallet: (start: AddWalletMode['start']) => void;
}) {
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<'list' | 'add'>('list');
  const [actionsFor, setActionsFor] = useState<string | null>(null);

  // Before the vault has been listed, show the open wallet on its own.
  const list: WalletInfo[] = wallets.length
    ? wallets
    : [{ id: openWallet.id, name: 'Wallet 1', kind: openWallet.kind }];
  const hues = walletHues(list.map((w) => w.id));

  useEffect(() => {
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A dialog over the panel takes its own Escape.
      if (document.querySelector('[data-wallet-dialog]')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* The other wallets' accounts come from their own settings, and their
     addresses from the public cache — derived once from the unlocked vault
     for any not cached yet, one wallet at a time so the panel paints first
     (rows show "Loading address…" until theirs land). */
  const walletKeyList = list.map((w) => `${w.id}:${w.kind}`).join(',');
  const others = useMemo(() => {
    const out: Record<string, WalletAccounts> = {};
    for (const w of list) if (w.id !== openWallet.id) out[w.id] = readWalletAccounts(w.id);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the wallet ids/kinds
  }, [walletKeyList, openWallet.id]);
  const [, setAddrTick] = useState(0);
  useEffect(() => {
    let cancel = false;
    const wanted = (w: WalletInfo) => (w.kind === 'key' ? [0] : others[w.id]?.visible ?? [0]);
    const missing = list.filter((w) => w.id !== openWallet.id && wanted(w).some((i) => !getWalletAddresses(w.id)[i]));
    if (!missing.length) return;
    void (async () => {
      for (const w of missing) {
        await new Promise((r) => setTimeout(r, 30)); // let the panel paint between wallets
        if (cancel) return;
        const secret = await readWalletSecret(w.id).catch(() => null);
        if (!secret || cancel) continue;
        setWalletAddresses(w.id, deriveWalletAddresses(secret, wanted(w)));
        setAddrTick((t) => t + 1);
      }
    })();
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the wallet ids/kinds
  }, [others]);

  const startAddWallet = () => {
    if (list.length >= MAX_WALLETS) return;
    setView('add');
  };

  const renderWalletCard = (w: WalletInfo) => {
    const open = w.id === openWallet.id;
    const pk = w.kind === 'key';
    const hue = hues[w.id] ?? 0;
    const group = walletGroupOf(w);
    const info: WalletAccounts | undefined = open
      ? { active: pk ? 0 : openWallet.activeIdx, visible: pk ? [0] : openWallet.visible, count: openWallet.count, names: {} }
      : others[w.id];
    const cached = open ? {} : getWalletAddresses(w.id);
    const addrOf = (i: number) => (open ? openWallet.addresses[i] : cached[i]);
    const nameOf = (i: number) => (open ? getAccountName(i) : info?.names[i] || `Account ${i + 1}`);
    const rows = !info ? [] : pk ? [0] : [info.active, ...info.visible.filter((i) => i !== info.active)];
    const lastAccount = openWallet.visible.length <= 1;
    const showActions = actionsFor === w.id;
    const several = list.length > 1;
    return (
      <div key={w.id} className={`${s.card} ${open ? s.cardOpen : ''}`}>
        {/* The wallet: icon, name, type badge, "…" */}
        <div className={s.walletRow}>
          <button
            type="button"
            className={s.walletMain}
            disabled={busy}
            onClick={() => { if (!open) onOpenWallet(w.id); }}
            aria-label={`${w.name}, ${walletOriginLabel(w)}${open ? ', open' : ' — open this wallet'}`}
            aria-current={open || undefined}
          >
            <IdentityIcon hue={hue} size={34} wallet={w.kind}/>
            <span className={s.walletText}>
              <span className={s.walletName}>{w.name}</span>
              <span className={s.walletMeta}>
                <span className={`${s.badge} ${BADGE_CLASS[group]}`}>{walletOriginLabel(w)}</span>
                {!pk && info && (
                  <span className={s.count}>
                    {info.visible.length} {info.visible.length === 1 ? 'account' : 'accounts'}
                  </span>
                )}
              </span>
            </span>
          </button>
          <button
            type="button"
            className={s.iconBtn}
            onClick={() => setActionsFor(showActions ? null : w.id)}
            aria-label={`${w.name} options`}
            aria-expanded={showActions}
            disabled={busy}
          >
            <Ellipsis size={18}/>
          </button>
        </div>

        {/* "…": Rename (several wallets) and Remove — inline, so it never
            clips at the bottom of the scrolling list. */}
        {showActions && (
          <div className={s.actions}>
            {several && (
              <button type="button" className={s.actionBtn} onClick={() => { setActionsFor(null); onRenameWallet(w.id); }}>
                <Pencil size={14}/> Rename
              </button>
            )}
            <button
              type="button"
              className={`${s.actionBtn} ${s.actionDanger}`}
              onClick={() => { setActionsFor(null); onRemoveWallet(w.id); }}
            >
              <Trash2 size={14}/> {several ? 'Remove wallet' : 'Delete wallet'}
            </button>
          </div>
        )}

        {/* Its accounts — the wallet's active one first. Tapping one opens
            this wallet on that account in one step. */}
        {rows.map((i) => {
          const on = open && i === (pk ? 0 : openWallet.activeIdx);
          const tag = rowAddress(addrOf(i));
          const name = nameOf(i);
          return (
            <div key={i} className={`${s.acctRow} ${on ? s.acctOn : ''}`}>
              <button
                type="button"
                className={s.acctMain}
                disabled={busy}
                onClick={() => onOpenAccount(w.id, i)}
                aria-current={on || undefined}
                aria-label={on ? `${name} (active)` : `Open ${name} in ${w.name}`}
              >
                <IdentityIcon hue={accountHue(hue, i)} size={30} label={accountInitials(name)}/>
                <span className={s.acctText}>
                  <span className={s.acctName}>{name}</span>
                  <span className={tag ? s.acctAddr : s.acctLoading} title={tag ? toLithoForm(addrOf(i) ?? '') : undefined}>
                    {tag ?? 'Loading address…'}
                  </span>
                </span>
                {on && <Check size={17} strokeWidth={2.6} className={s.tick}/>}
              </button>
              {/* Rename / delete for the open wallet's accounts (a wallet
                  keeps one account — delete is dimmed on the last). */}
              {open && (
                <button type="button" className={s.rowBtn} onClick={() => onRenameAccount(i)} aria-label={`Rename ${name}`} title="Rename account" disabled={busy}>
                  <Pencil size={14}/>
                </button>
              )}
              {open && !pk && (
                <button
                  type="button"
                  className={`${s.rowBtn} ${s.rowBtnDanger}`}
                  onClick={() => { if (!lastAccount) onDeleteAccount(i); }}
                  disabled={busy || lastAccount}
                  aria-label={`Delete ${name}`}
                  title={lastAccount ? 'A wallet keeps at least one account — add another to delete this one' : 'Delete account'}
                >
                  <Trash2 size={14}/>
                </button>
              )}
            </div>
          );
        })}
        {!info && <div className={s.cardLoading}><span className={s.spinner}/></div>}

        {/* "+ Add account" under every recovery-phrase wallet: its next
            derived account, opened. A private key has just the one. */}
        {!pk && info && info.count < MAX_ACCOUNTS && (
          <button type="button" className={s.addAcct} onClick={() => onAddAccount(w.id)} disabled={busy} aria-label={`Add an account to ${w.name}`}>
            <Plus size={16} strokeWidth={2.6}/> Add account
          </button>
        )}
      </div>
    );
  };

  return (
    <div className={s.backdrop} onClick={onClose}>
      <div
        ref={sheetRef}
        className={s.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={s.grabber} aria-hidden/>
        {view === 'list' && <>
          <div className={s.head}>
            <h2 id={titleId} className={s.title}>Wallets &amp; accounts</h2>
            {busy && <span className={s.spinner} role="status" aria-label="Working…"/>}
            <button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close"><X size={18}/></button>
          </div>
          <div className={s.scroll}>
            {WALLET_GROUPS.map((g) => {
              const inGroup = list.filter((w) => walletGroupOf(w) === g.key);
              if (!inGroup.length) return null;
              return (
                <section key={g.key} aria-label={g.title}>
                  <h3 className={s.groupTitle}>{g.title}</h3>
                  {inGroup.map(renderWalletCard)}
                </section>
              );
            })}
          </div>
          <div className={s.foot}>
            <button type="button" className={s.addWalletBtn} onClick={startAddWallet} disabled={busy || list.length >= MAX_WALLETS}>
              <Plus size={18} strokeWidth={2.6}/> Add wallet
            </button>
            {list.length >= MAX_WALLETS && (
              <p className={s.footNote}>Thanos holds up to {MAX_WALLETS} wallets. Remove one to add another.</p>
            )}
          </div>
        </>}

        {/* Add wallet — a new phrase (with the usual backup and verify
            steps) or an import, kept next to the others. */}
        {view === 'add' && <>
          <div className={s.head}>
            <button type="button" className={s.iconBtn} onClick={() => setView('list')} aria-label="Back to wallets and accounts">
              <ChevronLeft size={20}/>
            </button>
            <h2 id={titleId} className={s.title}>Add wallet</h2>
            <button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close"><X size={18}/></button>
          </div>
          <p className={s.lead}>
            Your current wallets stay — switch between them here. Each wallet has its own recovery phrase (or key) and accounts, under your one Thanos password.
          </p>
          <div className={s.options}>
            {([
              { start: 'create',     title: 'Create new wallet',      sub: 'A new recovery phrase to write down and verify', Icon: Sparkles },
              { start: 'phrase',     title: 'Import recovery phrase', sub: '12–24 words · full multi-chain wallet',           Icon: ScrollText },
              { start: 'privateKey', title: 'Import private key',     sub: 'Single EVM account · no BTC/SOL/Cosmos',          Icon: KeyRound },
            ] as const).map((o) => (
              <button key={o.start} type="button" className={s.option} onClick={() => onAddWallet(o.start)}>
                <span className={s.optionIcon}><o.Icon size={18}/></span>
                <span className={s.optionText}>
                  <span className={s.optionTitle}>{o.title}</span>
                  <span className={s.optionSub}>{o.sub}</span>
                </span>
                <ChevronRight size={18} className={s.optionChevron}/>
              </button>
            ))}
          </div>
        </>}
      </div>
    </div>
  );
}

/* ─── Dialogs over the panel (rename, remove, delete) ─────────────────── */

/** A themed dialog: a rename field, or a confirm whose destructive action
 *  takes a second click (the arming pattern Settings → Delete wallet uses). */
export function WalletDialog({
  title, body, input, action, armedAction, danger, onConfirm, onCancel,
}: {
  title: string;
  body?: string;
  /** A text field (rename). */
  input?: { value: string; placeholder: string; maxLength: number; onChange: (v: string) => void };
  /** The confirm button's label. */
  action: string;
  /** When set, the first click arms the button with this label; the second runs it. */
  armedAction?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [armed, setArmed] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!input) boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, input]);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5_000);
    return () => clearTimeout(t);
  }, [armed]);
  const confirm = () => {
    if (armedAction && !armed) { setArmed(true); return; }
    onConfirm();
  };
  return (
    <div className={s.dialogBackdrop} onClick={onCancel} data-wallet-dialog>
      <div
        ref={boxRef}
        className={s.dialog}
        role={danger ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className={s.dialogTitle}>{title}</h2>
        {body && <p className={s.dialogBody}>{body}</p>}
        {input && (
          <input
            className={s.dialogInput}
            autoFocus
            value={input.value}
            maxLength={input.maxLength}
            placeholder={input.placeholder}
            aria-label={title}
            onChange={(e) => input.onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
          />
        )}
        <div className={s.dialogBtns}>
          <button type="button" className={s.btnGhost} onClick={onCancel}>Cancel</button>
          <button type="button" className={danger ? s.btnDanger : s.btnPrimary} onClick={confirm}>
            {armed && armedAction ? armedAction : action}
          </button>
        </div>
      </div>
    </div>
  );
}
