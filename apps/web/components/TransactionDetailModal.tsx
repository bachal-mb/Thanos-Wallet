'use client';
/**
 * Transaction detail — opens when the user clicks a past activity row
 * (Transactions view, dashboard recent list). Client-requested layout:
 * a ≈fiat hero, signed amount, then Date / Status / Recipient and
 * Network fee / Nonce, with a block-explorer link.
 *
 * The activity row carries amount/symbol/counterparty/hash/when; the network
 * fee + nonce live only on chain, so they're fetched on open via
 * fetchOnchainTxDetails (sdk-core) — shown as "…" while loading and "—" if the
 * chain can't be resolved (honesty rule: never a fabricated value). Non-EVM
 * hashes get the explorer link only.
 *
 * Lithosphere Mainnet reads as LithoScan does (client 2026-10-15: "make
 * litho1 first class"): addresses as litho1…, the transaction by its native
 * hash, the 0x EVM hash only as a secondary line. A row that knows only the
 * 0x hash (a send made here, older rows) looks the native one up on open and
 * saves it onto the stored row.
 */
import React, { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import {
  convertFromUsd, withCurrencyAffix,
  fetchOnchainTxDetails, type OnchainTxDetails,
  fetchLithoNativeHash, lithoscanTxUrl, lithoscanAddressUrl,
} from '@thanos/sdk-core';
import { displayAddress, isLithoAddress, LITHO_MAINNET_CHAIN_ID } from '../lib/address';
import { findPendingTx, saveNativeHash } from '../lib/tx-store';
import { TOKENS } from '../lib/tokens';
import { useDisplayCurrency } from '../lib/use-fx';
import { useQuotes } from '../lib/usePrices';
import { TokenIcon } from './TokenIcon';
import type { IndexerActivityItem } from '../lib/indexer';

function txMeta(type: string): { title: string; out: boolean } {
  switch (type) {
    case 'send':     return { title: 'Sent',     out: true };
    case 'burn':     return { title: 'Burned',   out: true };
    case 'receive':  return { title: 'Received', out: false };
    case 'mint':     return { title: 'Minted',   out: false };
    case 'swap':     return { title: 'Swap',     out: false };
    case 'approval': return { title: 'Approval', out: false };
    default:         return { title: type ? type[0].toUpperCase() + type.slice(1) : 'Transaction', out: false };
  }
}

function fmtDateTime(ts?: string): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function shortAddr(a?: string | null): string {
  if (!a) return '—';
  // "litho1" is a fixed prefix — keep as much of the account itself as 0x shows.
  if (a.startsWith('litho1')) return a.length > 20 ? `${a.slice(0, 12)}…${a.slice(-6)}` : a;
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function shortHash(h: string): string {
  return h.length > 22 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h;
}

/** Copies exactly what the row shows. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button" title={`Copy ${label}`} aria-label={`Copy ${label}`}
      onClick={() => {
        navigator.clipboard?.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      style={{
        background: 'none', border: 'none', padding: 2, marginLeft: 6, cursor: 'pointer',
        color: copied ? 'var(--green)' : 'var(--text-muted)', display: 'inline-flex', verticalAlign: 'middle',
      }}
    >
      {copied ? <Check size={13}/> : <Copy size={13}/>}
    </button>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
      padding: '11px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: 13, gap: 12,
    }}>
      <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontWeight: 600, textAlign: 'right', minWidth: 0, wordBreak: 'break-word' }}>{children}</span>
    </div>
  );
}

/* Re-renders on display-currency change — see lib/use-fx.ts. */
export function TransactionDetailModal({ item, onClose }: { item: IndexerActivityItem; onClose: () => void }) {
  useDisplayCurrency();
  const quotes = useQuotes();
  const meta = txMeta(item.type);
  const canon = TOKENS.find(t => t.sym.toLowerCase() === item.symbol.toLowerCase());
  // Activity amounts are ALREADY human-readable: the indexer runs
  // formatTokenAmount(amount, decimals) (services/indexer lep100-sync.ts) and
  // local optimistic rows store what the user typed. Re-applying formatUnits
  // treated a whole-number "30" as 30 wei and collapsed it to ~0 — a real
  // 30-FGPT receive rendered as "+0 FGPT". Parse the value directly.
  const amountNum = parseFloat(String(item.amount).replace(/^[+-]/, '')) || 0;
  const amountStr = amountNum.toLocaleString('en-US', { maximumFractionDigits: 6 });

  const priceUsd = quotes?.[item.symbol]?.usd ?? (canon?.priceUsd || null);
  const fiat = priceUsd != null
    ? withCurrencyAffix(convertFromUsd(amountNum * priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
    : null;

  const statusText  = item.status === 'pending' ? 'Pending' : item.status === 'failed' ? 'Failed' : 'Completed';
  const statusColor = item.status === 'pending' ? 'var(--orange)' : item.status === 'failed' ? 'var(--red)' : 'var(--green)';

  /* Network fee + nonce live only on chain — fetch on open. */
  const [det, setDet] = useState<OnchainTxDetails | null>(null);
  const [detLoading, setDetLoading] = useState<boolean>(!!item.txHash);
  useEffect(() => {
    if (!item.txHash) { setDetLoading(false); return; }
    let cancel = false;
    setDetLoading(true);
    fetchOnchainTxDetails(item.txHash)
      .then(d => { if (!cancel) { setDet(d); setDetLoading(false); } })
      .catch(() => { if (!cancel) setDetLoading(false); });
    return () => { cancel = true; };
  }, [item.txHash]);

  const feeText = det?.feeNative != null
    ? `${det.feeNative.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${det.nativeSymbol}`
    : (detLoading ? '…' : '—');
  const feeUsdText = det?.feeUsd != null
    ? '≈ ' + withCurrencyAffix(convertFromUsd(det.feeUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }))
    : null;
  const nonceText = det?.nonce != null ? String(det.nonce) : (detLoading ? '…' : '—');

  // Lithosphere Mainnet — or, for a send saved before its chain was
  // recorded, wherever the lookup found it.
  const isLitho = item.chainId === LITHO_MAINNET_CHAIN_ID
    || (item.chainId == null && det?.chainId === LITHO_MAINNET_CHAIN_ID);
  const txHash = item.txHash ?? '';
  const evmHash = /^0x[0-9a-fA-F]{64}$/.test(txHash) ? txHash : null;

  /* Lithosphere's native hash: the row's own (or saved since the list was
     read), else looked up from the 0x hash and saved onto the stored row, so
     only once. Until it's known the 0x hash shows, labelled "EVM hash". */
  const [nativeHash, setNativeHash] = useState<string | null>(
    () => item.nativeHash ?? findPendingTx(item.id)?.nativeHash ?? null,
  );
  useEffect(() => {
    if (!isLitho || nativeHash || !evmHash) return;
    let cancel = false;
    void fetchLithoNativeHash(evmHash).then(h => {
      if (cancel || !h) return;
      setNativeHash(h);
      try { saveNativeHash(evmHash, h); } catch { /* storage off — looked up again next time */ }
    });
    return () => { cancel = true; };
  }, [isLitho, nativeHash, evmHash]);
  const shownHash = (isLitho && nativeHash) || txHash;
  const hashLabel = isLitho && !nativeHash && evmHash ? 'EVM hash' : 'Transaction hash';

  const rawCounterparty = item.counterparty ?? (meta.out ? det?.to : det?.from) ?? null;
  // litho1… on Lithosphere (explorer rows already are); 0x elsewhere.
  const counterparty = rawCounterparty && displayAddress(rawCounterparty, isLitho ? LITHO_MAINNET_CHAIN_ID : null);
  const recipientLabel = meta.out ? 'Recipient' : 'From';
  // Only a link the lookup found — never a guessed explorer for another chain.
  // Lithosphere: LithoScan's page, by the native hash once known.
  const explorer = isLitho && txHash ? lithoscanTxUrl(nativeHash ?? txHash) : det?.explorerTxUrl ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box modal-popup" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{meta.title}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-scroll">
          {/* Hero: ≈fiat + signed amount */}
          <div style={{ textAlign: 'center', padding: '10px 0 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <TokenIcon sym={item.symbol} color={canon?.color} size={44} style={{ borderRadius: 14 }}/>
            <div style={{ fontSize: 30, fontWeight: 800, marginTop: 4 }}>{fiat ? `≈ ${fiat}` : `${meta.out ? '-' : '+'}${amountStr} ${item.symbol}`}</div>
            <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>{meta.out ? '-' : '+'}{amountStr} {item.symbol}</div>
          </div>

          {/* Date / Status / Recipient / Network */}
          <div className="card" style={{ padding: '2px 14px', marginBottom: 12 }}>
            <DetailRow label="Date">{fmtDateTime(item.ts)}</DetailRow>
            <DetailRow label="Status"><span style={{ color: statusColor, fontWeight: 700 }}>{statusText}</span></DetailRow>
            {counterparty && (
              <DetailRow label={recipientLabel}>
                <span style={{ fontFamily: 'Geist Mono, monospace' }} title={counterparty}>{shortAddr(counterparty)}</span>
                {isLitho && isLithoAddress(counterparty) && (
                  <a href={lithoscanAddressUrl(counterparty)} target="_blank" rel="noreferrer"
                    title="View on LithoScan" aria-label="View address on LithoScan"
                    style={{ color: 'var(--text-muted)', marginLeft: 6, display: 'inline-flex', verticalAlign: 'middle' }}>
                    <ExternalLink size={13}/>
                  </a>
                )}
                <CopyButton value={counterparty} label="address"/>
              </DetailRow>
            )}
            {/* A history row knows its network; a lookup fills in the rest. */}
            {(item.network ?? det?.networkName) && <DetailRow label="Network">{item.network ?? det?.networkName}</DetailRow>}
            {shownHash && (
              <DetailRow label={hashLabel}>
                <span style={{ fontFamily: 'Geist Mono, monospace' }} title={shownHash}>{shortHash(shownHash)}</span>
                <CopyButton value={shownHash} label={hashLabel.toLowerCase()}/>
                {/* The 0x form second, as LithoScan shows it. */}
                {isLitho && nativeHash && evmHash && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, marginTop: 2 }}>
                    EVM hash <span style={{ fontFamily: 'Geist Mono, monospace' }} title={evmHash}>{shortHash(evmHash)}</span>
                    <CopyButton value={evmHash} label="EVM hash"/>
                  </div>
                )}
              </DetailRow>
            )}
          </div>

          {/* Network fee / Nonce (EVM hashes only) */}
          {item.txHash && (
            <div className="card" style={{ padding: '2px 14px', marginBottom: 12 }}>
              <DetailRow label="Network fee">
                <span>
                  <div>{feeText}</div>
                  {feeUsdText && <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>{feeUsdText}</div>}
                </span>
              </DetailRow>
              <DetailRow label="Nonce">{nonceText}</DetailRow>
            </div>
          )}

          {explorer && (
            <a href={explorer} target="_blank" rel="noreferrer" className="btn-outline"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, textDecoration: 'none', color: 'var(--green)', fontWeight: 700, padding: '13px' }}>
              {isLitho ? 'View on LithoScan' : 'View on block explorer'}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
