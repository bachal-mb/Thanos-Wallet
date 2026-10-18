'use client';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { HDNodeWallet, Mnemonic } from 'ethers';
import { useTheme } from '../providers/ThemeProvider';
import { TopNav } from './TopNav';
import { BottomNav } from './BottomNav';
import { OnboardingFlow, useWalletGate, type AddWalletMode } from '../onboarding';
import { WalletsPanel, WalletDialog, type OpenWalletState } from './WalletsPanel';
import { dualFromEvm, type DualAddress } from '../../lib/address';
import { WalletConnectHost } from '../WalletConnectHost';
import { AddNetworkNudge, MainnetWelcomeCard } from '../LithosphereNetworkPrompt';
import { preloadTokenLogos } from '../../lib/token-logos';
import { setContactEncryptionKey } from '../../lib/contact-crypto';
import {
  getActiveAccountIndex, setActiveAccountIndex,
  getAccountCount, setAccountCount, MAX_ACCOUNTS, MAX_ACCOUNT_NAME_LEN,
  getCustomAccountName, setAccountName, hideAccount,
  getAccountName, getVisibleAccountIndices,
  listWallets, switchWallet, openAccount, addAccountToWallet, renameWallet, removeWallet,
  readWalletAccounts, readWalletSecret, getWalletAddresses, setWalletAddresses,
  isSeedBackedUp, clearVault, currentWalletId, MAX_WALLET_NAME_LEN,
  type StoredWallet, type WalletInfo,
} from '../../lib/vault';
import { accountUsdValue, DELETE_MAX_USD } from '../../lib/account-balance';
import { usePrices } from '../../lib/usePrices';
import { formatFiat } from '@thanos/sdk-core';
import { discoverFundedAccountCount, deriveAccountAddresses, deriveWalletAddresses } from '../../lib/account-discovery';
import { setSignerAccountIndex } from '../../lib/signer-client';
import { initDisplayCurrency, subscribeFx } from '@thanos/sdk-core';

/** The vault's wallets — for Settings and anything else that lists or
 *  manages them (lib/vault.ts, "Several wallets in one vault"). */
export interface WalletsApi {
  list: WalletInfo[];
  activeId: string;
  /** The open wallet's name ("Wallet 1" until the vault has been listed). */
  activeName: string;
  /** What the wallet list offers, in a line. */
  hint: string;
  /** Show the Wallets & accounts panel. */
  open: () => void;
  /** Remove a wallet after the balance / backup confirmations — the last
   *  one runs the full delete flow. */
  remove: (id: string) => void;
}

/* Wallet context — exposes the unlocked address (in both formats) AND the
   raw mnemonic words to any descendant. The mnemonic is needed only when a
   signature is required (Send tx, sign message, etc.) — never store it in
   a parent component beyond the WalletGate that decrypted it.
   Null until unlocked. Everything here is the OPEN wallet's: opening
   another wallet of the vault swaps it all at once. */
interface WalletContextValue {
  evmAddress: string;
  addresses:  DualAddress | null;
  /** The unlocked BIP39 phrase (split into words). Empty when the wallet
   *  was imported from a raw private key — see `privateKey` below. */
  seed:       string[];
  /** Raw 0x-prefixed private key, set ONLY when the wallet was imported
   *  via private key (not derived from a mnemonic). */
  privateKey?: string;
  /** The user's own accounts (visible HD indices) — Send offers them as
   *  one-tap recipients for moving funds between owned wallets. */
  ownAccounts?: Array<{ idx: number; name: string; address: string }>;
  /** The open wallet of the vault. */
  walletId:   string;
  wallets:    WalletsApi;
}
const WalletContext = createContext<WalletContextValue | null>(null);
export function useWallet(): WalletContextValue | null {
  return useContext(WalletContext);
}

/** Erase every wallet from this device — Settings → Delete wallet, and the
 *  last wallet's Remove in the wallet list. Drops the Quantt login with it
 *  (the local clear is synchronous, so it lands before the reload); the full
 *  reload lands on onboarding with no unlocked state left in memory. */
export async function eraseAllWallets(): Promise<void> {
  clearVault();
  try {
    const q = await import('../../lib/quantt');
    void q.forgetQuanttSession().catch(() => { /* nothing to forget */ });
  } catch { /* Quantt unavailable — nothing to forget */ }
  window.location.href = '/app';
}

type RenameTarget = { kind: 'account'; idx: number } | { kind: 'wallet'; id: string };
interface ConfirmRequest { title: string; body: string; action: string; armedAction: string; onConfirm: () => void }

export function AppShell({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  const {
    unlocked, hasVault, onComplete, lock, evmAddress, walletSeed, walletPrivateKey, walletId, showWallet,
  } = useWalletGate();

  // Display-currency boot + live updates. Prices are held in USD internally and
  // converted at FORMAT time, so a currency change only needs the tree to
  // re-render — this tick does that. Without it the Settings picker would
  // change the stored preference but leave every on-screen figure stale.
  const [, setFxTick] = useState(0);
  useEffect(() => {
    void initDisplayCurrency().then(() => setFxTick(t => t + 1));
    return subscribeFx(() => setFxTick(t => t + 1));
  }, []);

  // Multi-account state of the OPEN wallet. activeIdx is the HD-path the
  // wallet derives from; accountCount is how many indices it has. Mnemonic-
  // only — privateKey-imported wallets are single-account by definition.
  // Each wallet keeps its own (lib/vault.ts walletKey), so they're re-read
  // whenever another wallet opens.
  const isMnemonicWallet = walletSeed.length > 0 && !walletPrivateKey;
  const [activeIdx, setActiveIdx]       = useState(0);
  const [accountCount, setAccountCountState] = useState(1);
  useEffect(() => {
    if (!unlocked) return;
    setActiveIdx(getActiveAccountIndex());
    setAccountCountState(getAccountCount());
  }, [unlocked, walletId]);
  const curAcctIdx = isMnemonicWallet ? activeIdx : 0;

  // Re-derive the EVM address from the unlocked seed at activeIdx.
  // For PK-only wallets the upstream evmAddress is authoritative.
  const derivedEvm = useMemo(() => {
    if (!isMnemonicWallet) return evmAddress;
    try {
      const m  = Mnemonic.fromPhrase(walletSeed.join(' '));
      const hd = HDNodeWallet.fromMnemonic(m, `m/44'/60'/0'/0/${activeIdx}`);
      return hd.address;
    } catch { return evmAddress; }
  }, [isMnemonicWallet, walletSeed, activeIdx, evmAddress]);

  // Push the active index into the signer worker so the next signed
  // tx broadcasts from the displayed account.
  useEffect(() => {
    if (!unlocked || !isMnemonicWallet) return;
    void setSignerAccountIndex(activeIdx).catch(() => { /* worker not ready yet */ });
  }, [activeIdx, unlocked, isMnemonicWallet]);

  // Account discovery — scan HD indices for funded accounts so a deposit made
  // to a non-active index (or any account on a freshly imported wallet) becomes
  // reachable in the switcher instead of being invisible. Runs once per unlock
  // and per opened wallet; only ever GROWS accountCount, never hides an
  // account the user already has.
  useEffect(() => {
    if (!unlocked || !isMnemonicWallet || walletSeed.length === 0) return;
    let cancel = false;
    // The count belongs to this wallet — never write it after another opened.
    const wid = currentWalletId();
    void discoverFundedAccountCount(walletSeed)
      .then((n) => {
        if (cancel || currentWalletId() !== wid) return;
        if (n > getAccountCount()) { setAccountCount(n); setAccountCountState(n); }
      })
      .catch(() => { /* best-effort */ });
    return () => { cancel = true; };
  }, [unlocked, isMnemonicWallet, walletSeed]);

  // Per-account EVM addresses for the switcher (so users can identify which
  // numbered account is which, rather than a bare "Account N").
  const accountAddresses = useMemo(
    () => (isMnemonicWallet ? deriveAccountAddresses(walletSeed, accountCount) : []),
    [isMnemonicWallet, walletSeed, accountCount],
  );

  const ownAccounts = useMemo(
    () => getVisibleAccountIndices().filter((i) => !!accountAddresses[i]).map((i) => ({ idx: i, name: getAccountName(i), address: accountAddresses[i] })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountAddresses, accountCount],
  );

  // Cache the open wallet's account addresses (public, never a secret) so
  // the wallet list shows them whichever wallet is open. walletId and the
  // seed are set together (useWalletGate), so they always belong together.
  useEffect(() => {
    if (!unlocked) return;
    const addrs: Record<number, string> = {};
    if (isMnemonicWallet) accountAddresses.forEach((a, i) => { if (a) addrs[i] = a; });
    else if (walletPrivateKey) addrs[0] = evmAddress;
    setWalletAddresses(walletId, addrs);
  }, [unlocked, isMnemonicWallet, walletPrivateKey, accountAddresses, evmAddress, walletId]);

  const switchAccount = (idx: number) => {
    if (idx < 0 || idx >= accountCount) return;
    setActiveAccountIndex(idx);
    setActiveIdx(idx);
  };
  const addAccount = () => {
    if (accountCount >= MAX_ACCOUNTS) return;
    const next = accountCount;
    setAccountCount(next + 1);
    setAccountCountState(next + 1);
    setActiveAccountIndex(next);
    setActiveIdx(next);
  };

  /* ─── Rename / delete account ─────────────────────────────────────────
     Rename is a small themed dialog (no native prompt — it'd break the dark
     UI). Delete always confirms; an account holding more than
     DELETE_MAX_USD, or whose balance can't be checked, can still go after a
     reminder about the recovery phrase (client, 2026-10-10) — a native
     confirm, as befits a rare destructive step. Removal hides the HD index (see
     lib/vault.ts hideAccount) — indices never shift, so no address moves. */
  const [rename,    setRename]      = useState<RenameTarget | null>(null);
  const [renameVal, setRenameVal]   = useState('');
  const [acctBusy,  setAcctBusy]    = useState(false);
  const [acctError, setAcctError]   = useState<string | null>(null);
  const [nameTick,  setNameTick]    = useState(0); // re-render the switcher after a rename
  const prices = usePrices();

  const openRename = (idx: number) => {
    setRename({ kind: 'account', idx });
    setRenameVal(getCustomAccountName(idx) ?? '');
    setAcctError(null);
  };

  const deleteAccount = async (idx: number) => {
    setAcctError(null);
    const addr = accountAddresses[idx];
    if (!addr) { setAcctError('Could not resolve that account — try again.'); return; }
    setAcctBusy(true);
    try {
      const usd = await accountUsdValue(addr, prices ?? {});
      // Funds don't block deleting (client, 2026-10-10) — the account only
      // leaves this list; the user is reminded that the recovery phrase is
      // what reaches the funds afterwards.
      const name = getAccountName(idx);
      const held = usd == null
        ? "We couldn't check what this account holds."
        : usd > DELETE_MAX_USD ? `It holds about ${formatFiat(usd)}.` : null;
      const ask = held
        ? `Delete ${name}?\n\n${held} Deleting only removes it from Thanos — any funds stay at its address on the blockchain, and only your recovery phrase can get them back.\n\nMake sure your recovery phrase is written down before you continue.`
        : `Delete ${name}? The same recovery phrase can restore it later.`;
      if (!window.confirm(ask)) return;
      if (!hideAccount(idx)) {
        setAcctError('That account can\'t be removed — a wallet must keep at least one.');
        return;
      }
      setActiveIdx(getActiveAccountIndex());
      setNameTick(t => t + 1);
    } finally {
      setAcctBusy(false);
    }
  };

  /* ─── Wallets — several secrets in the one vault (lib/vault.ts) ──────────
     Each wallet keeps its own accounts. Opening one makes its secret the
     signing secret (useWalletGate.showWallet → the signer worker) and loads
     its account settings; the address, seed and accounts then flow through
     WalletContext exactly like an account switch, so Home, Activity, Send /
     Receive, WalletConnect and Quantts all follow it. Same model as the
     phone app and the extension. */
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [walletsOpen, setWalletsOpen] = useState(false);
  /** What a running wallet action is doing (shown while it runs), or null. */
  const [walletBusy, setWalletBusy] = useState<string | null>(null);
  const [addStart, setAddStart] = useState<AddWalletMode['start'] | null>(null);
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const refreshWallets = useCallback(async () => {
    const r = await listWallets().catch(() => null);
    if (r) setWallets(r.wallets);
  }, []);
  useEffect(() => {
    if (unlocked) { void refreshWallets(); return; }
    // Locked: nothing of the last session stays open behind the unlock screen.
    setWallets([]); setWalletsOpen(false); setAddStart(null); setConfirmReq(null); setRename(null);
  }, [unlocked, walletId, refreshWallets]);
  const activeWalletName = wallets.find((w) => w.id === walletId)?.name ?? 'Wallet 1';
  const openWalletsPanel  = useCallback(() => setWalletsOpen(true), []);
  const closeWalletsPanel = useCallback(() => setWalletsOpen(false), []);

  /** Show the wallet lib/vault.ts has just opened (its account settings are
   *  what the vault's account functions now read). */
  const showOpenedWallet = (w: StoredWallet) => {
    showWallet(w);
    setActiveIdx(getActiveAccountIndex());
    setAccountCountState(getAccountCount());
    setNameTick(t => t + 1);
  };
  const runWalletAction = async (label: string, fn: () => Promise<void>) => {
    if (walletBusy) return;
    setWalletBusy(label);
    try { await fn(); } finally { setWalletBusy(null); }
  };
  const OPEN_FAILED = 'Couldn’t open that wallet — lock and unlock Thanos, then try again.';

  /** Open account `idx` of any wallet in one step (in the open wallet it's a
   *  plain account switch). */
  const openAccountIn = (id: string, idx: number) => {
    setWalletsOpen(false);
    if (id === walletId) { if (isMnemonicWallet) switchAccount(idx); return; }
    void runWalletAction('Opening wallet…', async () => {
      const w = await openAccount(id, idx);
      if (w) showOpenedWallet(w); else setAcctError(OPEN_FAILED);
    });
  };
  const openWalletById = (id: string) => {
    if (id === walletId) return;
    setWalletsOpen(false);
    void runWalletAction('Opening wallet…', async () => {
      const w = await switchWallet(id);
      if (w) showOpenedWallet(w); else setAcctError(OPEN_FAILED);
    });
  };
  /** "+ Add account" under a wallet — any wallet, not only the open one: its
   *  next derived account, opened. */
  const addAccountIn = (id: string) => {
    setWalletsOpen(false);
    if (id === walletId) { if (isMnemonicWallet) addAccount(); return; }
    void runWalletAction('Adding account…', async () => {
      const r = await addAccountToWallet(id);
      if ('error' in r) { setAcctError(r.error); return; }
      showOpenedWallet(r.wallet);
    });
  };
  const openWalletRename = (id: string) => {
    setRename({ kind: 'wallet', id });
    setRenameVal(wallets.find((w) => w.id === id)?.name ?? '');
  };
  const commitRename = async () => {
    if (!rename) return;
    setRename(null);
    if (rename.kind === 'account') {
      setAccountName(rename.idx, renameVal);
      setNameTick(t => t + 1);
      return;
    }
    if (!renameVal.trim()) return; // an empty name keeps the old one
    if (await renameWallet(rename.id, renameVal)) await refreshWallets();
    else setAcctError('Couldn’t rename the wallet — lock and unlock Thanos, then try again.');
  };

  /** Every listed address of a wallet — the open one from state; another
   *  from the address cache, derived from its secret only if some are missing. */
  const walletAddressesOf = async (w: WalletInfo): Promise<string[]> => {
    if (w.id === walletId) {
      return isMnemonicWallet
        ? getVisibleAccountIndices().map((i) => accountAddresses[i]).filter(Boolean)
        : [evmAddress];
    }
    const want = w.kind === 'key' ? [0] : readWalletAccounts(w.id).visible;
    const known = getWalletAddresses(w.id);
    if (want.every((i) => known[i])) return want.map((i) => known[i]);
    const secret = await readWalletSecret(w.id);
    if (!secret) return [];
    const derived = deriveWalletAddresses(secret, want);
    setWalletAddresses(w.id, derived);
    return want.map((i) => derived[i]).filter(Boolean);
  };

  /* Removing the last wallet erases the vault — the full delete flow, with
     Settings → Delete wallet's wording and its click-twice confirm. */
  const requestFullDelete = () => {
    const noun = isMnemonicWallet ? 'recovery phrase' : 'private key';
    setConfirmReq({
      title: 'Delete wallet?',
      body: isSeedBackedUp()
        ? `This erases the wallet from this device. You can restore it later with your ${noun}.`
        : `You have NOT backed up your ${noun}.\n\nIf you delete this wallet now, these funds are gone permanently — nobody can recover them.`,
      action: 'Delete wallet',
      armedAction: 'Click again to erase',
      onConfirm: () => { setConfirmReq(null); void eraseAllWallets(); },
    });
  };

  /* Remove a wallet. Funds don't block it, as with accounts: what it holds
     is checked first, and the user is reminded that only its recovery phrase
     (or key) reaches the funds afterwards. Copy follows the phone's. */
  const confirmRemoveWallet = (id: string) => void runWalletAction('Checking wallet balance…', async () => {
    const list = (await listWallets().catch(() => null))?.wallets ?? wallets;
    if (list.length <= 1) { requestFullDelete(); return; }
    const w = list.find((x) => x.id === id);
    if (!w) return;
    let usd: number | null = null;
    const backedUp = isSeedBackedUp(id);
    try {
      const addrs = await walletAddressesOf(w);
      const vals = addrs.length ? await Promise.all(addrs.map((a) => accountUsdValue(a, prices ?? {}))) : [null];
      usd = vals.some((v) => v == null) ? null : vals.reduce<number>((sum, v) => sum + (v ?? 0), 0);
    } catch { usd = null; }

    const label = `“${w.name}”`;
    const noun = w.kind === 'key' ? 'private key' : 'recovery phrase';
    const held = usd == null
      ? 'We couldn’t check what this wallet holds.'
      : usd > DELETE_MAX_USD ? `It holds about ${formatFiat(usd)}.` : null;
    const body = held
      ? `${backedUp ? '' : `You have NOT backed up ${label}'s ${noun}. `}${held} Removing it only takes it off this device — any funds stay at its address on the blockchain, and only its ${noun} can get them back.\n\nMake sure its ${noun} is written down before you continue.`
      : backedUp
        ? `Remove ${label} from this device? You can restore it later with its ${noun}. Your other wallets stay.`
        : `You have NOT backed up ${label}'s ${noun}.\n\nIf you remove it now, its funds are gone permanently — nobody can recover them.`;
    setConfirmReq({
      title: `Remove ${w.name}?`,
      body,
      action: 'Remove wallet',
      armedAction: 'Click again to remove',
      onConfirm: () => {
        setConfirmReq(null);
        void runWalletAction('Removing wallet…', async () => {
          const r = await removeWallet(id);
          if ('error' in r) { setAcctError(r.error); return; }
          if (id === walletId) showOpenedWallet(r.next);
          await refreshWallets();
        });
      },
    });
  });

  /** What Wallets & accounts offers, in a line (account menu, Settings). */
  const walletsHint = wallets.length > 1
    ? `${wallets.length} wallets · switch, add or import`
    : isMnemonicWallet ? 'Add an account or another wallet' : 'Add or import another wallet';

  const walletsApi: WalletsApi = {
    list: wallets,
    activeId: walletId,
    activeName: activeWalletName,
    hint: walletsHint,
    open: openWalletsPanel,
    remove: confirmRemoveWallet,
  };

  const openWalletState: OpenWalletState = {
    id: walletId,
    kind: isMnemonicWallet ? 'phrase' : 'key',
    activeIdx: curAcctIdx,
    visible: isMnemonicWallet ? getVisibleAccountIndices() : [0],
    count: isMnemonicWallet ? accountCount : 1,
    addresses: isMnemonicWallet ? accountAddresses : [evmAddress],
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  /* Fire-and-forget one-time bootstrap of CoinGecko's top-250 logo map.
     TokenIcon reads the cached map synchronously after this lands. Skipped
     entirely on SSR (preloadTokenLogos guards on window). */
  useEffect(() => {
    void preloadTokenLogos();
  }, []);

  /* Derive + cache the contact-encryption key from the unlocked seed.
     Cleared when the wallet locks (walletSeed goes empty). The address
     book uses this to encrypt name + notes before POSTing to /contacts. */
  useEffect(() => {
    void setContactEncryptionKey(unlocked ? walletSeed : null);
    return () => { void setContactEncryptionKey(null); };
  }, [unlocked, walletSeed]);

  // Wait for client-side check (avoid SSR mismatch)
  if (hasVault === null) {
    return <div className="app-shell" style={{ background: 'var(--bg-base)' }}/>;
  }

  if (!unlocked) {
    return <OnboardingFlow hasVault={hasVault} onComplete={onComplete}/>;
  }

  const addresses = dualFromEvm(derivedEvm);
  const renameIsWallet = rename?.kind === 'wallet';

  return (
    <WalletContext.Provider value={{ evmAddress: derivedEvm, addresses, seed: walletSeed, privateKey: walletPrivateKey, ownAccounts, walletId, wallets: walletsApi }}>
      <WalletConnectHost/>
      {/* First-run Lithosphere Mainnet prompts — both self-gate via
          localStorage, so they appear at most once per browser. The welcome
          card introduces the home network; the nudge offers to add it to an
          external injected wallet (MetaMask etc.) if one is present. */}
      <MainnetWelcomeCard/>
      <AddNetworkNudge/>
      {/* Height lives in globals.css (.app-shell): 100dvh — not 100vh —
          so iOS Safari's collapsing URL bar can't strand content below
          the fold, and divided by the desktop zoom factor so the zoomed
          shell still fits the real viewport exactly. This was the
          "Discover page sometimes can't scroll" bug. */}
      <div className="app-shell" style={{ display: 'flex', flexDirection: 'column' }}>
        <TopNav
          key={nameTick}
          onLock={lock}
          activeIdx={curAcctIdx}
          walletName={wallets.length > 1 ? activeWalletName : undefined}
          walletsHint={walletsHint}
          onOpenWallets={openWalletsPanel}
          onRenameAccount={openRename}
          onDeleteAccount={isMnemonicWallet ? (i) => { void deleteAccount(i); } : undefined}
        />
        <main style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
          {children}
        </main>
        <BottomNav/>

        {/* Wallets & accounts — every wallet with its accounts. */}
        {walletsOpen && (
          <WalletsPanel
            wallets={wallets}
            openWallet={openWalletState}
            busy={!!walletBusy || acctBusy}
            onClose={closeWalletsPanel}
            onOpenAccount={openAccountIn}
            onOpenWallet={openWalletById}
            onAddAccount={addAccountIn}
            onRenameAccount={openRename}
            onDeleteAccount={(i) => { void deleteAccount(i); }}
            onRenameWallet={openWalletRename}
            onRemoveWallet={confirmRemoveWallet}
            onAddWallet={(start) => { setWalletsOpen(false); setAddStart(start); }}
          />
        )}

        {/* Add wallet — the onboarding create / import steps in add mode:
            the new wallet joins the vault under the same password and opens
            on its first account. Closing returns to the wallet list. */}
        {addStart && (
          <div className="wallet-add-overlay" role="dialog" aria-modal="true" aria-label="Add wallet">
            <OnboardingFlow
              hasVault
              onComplete={() => { /* add mode reports through onAdded */ }}
              addMode={{
                start: addStart,
                onCancel: () => { setAddStart(null); setWalletsOpen(true); },
                onAdded: (w) => { setAddStart(null); showOpenedWallet(w); void refreshWallets(); },
              }}
            />
          </div>
        )}

        {/* Rename an account (empty restores "Account N") or a wallet. */}
        {rename && (
          <WalletDialog
            title={renameIsWallet ? 'Rename wallet' : 'Rename account'}
            body={renameIsWallet ? 'Shown in the wallet list and under the account name.' : 'Leave blank to restore the default name.'}
            input={{
              value: renameVal,
              onChange: setRenameVal,
              maxLength: renameIsWallet ? MAX_WALLET_NAME_LEN : MAX_ACCOUNT_NAME_LEN,
              placeholder: rename.kind === 'account' ? `Account ${rename.idx + 1}` : 'Wallet name',
            }}
            action="Save"
            onConfirm={() => { void commitRename(); }}
            onCancel={() => setRename(null)}
          />
        )}

        {/* Remove a wallet / erase the last one. */}
        {confirmReq && (
          <WalletDialog
            title={confirmReq.title}
            body={confirmReq.body}
            action={confirmReq.action}
            armedAction={confirmReq.armedAction}
            danger
            onConfirm={confirmReq.onConfirm}
            onCancel={() => setConfirmReq(null)}
          />
        )}

        {/* Delete-guard feedback — why an account could not be removed. */}
        {(acctError || acctBusy || (walletBusy && !walletsOpen)) && (
          <div
            role="status"
            style={{
              position: 'fixed', left: '50%', bottom: 88, transform: 'translateX(-50%)',
              maxWidth: 420, padding: '10px 14px', borderRadius: 10, zIndex: 9999,
              background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
              color: acctError ? 'var(--red, #f87171)' : 'var(--text-secondary)', fontSize: 12.5,
              boxShadow: '0 10px 28px rgba(0,0,0,0.28)',
            }}
            onClick={() => setAcctError(null)}
          >
            {acctBusy ? 'Checking account balance…' : acctError ?? walletBusy}
          </div>
        )}
      </div>
    </WalletContext.Provider>
  );
}
