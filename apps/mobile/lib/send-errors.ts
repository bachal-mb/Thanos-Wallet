/**
 * Plain-language text for a failed send. Node / ethers errors arrive as
 * "could not coalesce error (error={ "code": -32000, "message": "tx already
 * in mempool" }, payload={ … signed tx … })" — a user must never see that
 * (client 2026-10-16, a Lithosphere send the website had already broadcast,
 * re-sent from the app). Matches on the error code and the node's message,
 * and never echoes the payload.
 *
 * Dependency-free so the mobile app can carry a detached twin
 * (apps/mobile/lib/send-errors.ts) — keep the two identical; the sdk-core
 * test suite runs against both.
 */

/** The node's own message inside an ethers error, when there is one. */
function nodeMessage(e: unknown): string {
  const o = e as { error?: { message?: unknown }; info?: { error?: { message?: unknown } }; shortMessage?: unknown } | null;
  const inner = o?.error?.message ?? o?.info?.error?.message;
  if (typeof inner === 'string' && inner.trim()) return inner.trim();
  const raw = String((e as Error)?.message ?? '');
  const m = raw.match(/"message"\s*:\s*"([^"]{1,200})"/);
  return m ? m[1].trim() : '';
}

export function humanSendError(e: unknown): string {
  const raw = String((e as Error)?.message ?? '');
  const code = String((e as { code?: unknown })?.code ?? '');
  const s = `${code} ${raw} ${nodeMessage(e)}`.toLowerCase();

  if (code === 'ACTION_REJECTED' || s.includes('user rejected') || s.includes('user denied'))
    return 'Transaction cancelled.';
  if (s.includes('already in mempool') || s.includes('already known') || s.includes('known transaction')
      || s.includes('already imported') || s.includes('tx already exists'))
    return 'This payment is already on its way — the same transaction was sent before (from this '
      + 'device, the website or another app) and is waiting to be included. Nothing extra was sent; '
      + 'it shows in Activity once it confirms.';
  if (code === 'INSUFFICIENT_FUNDS' || s.includes('insufficient funds') || s.includes('insufficient balance'))
    return 'Not enough balance to cover the amount plus the network fee.';
  if (code === 'REPLACEMENT_UNDERPRICED' || s.includes('replacement transaction underpriced') || s.includes('replacement fee too low'))
    return 'Another transaction from this wallet is still waiting — let it confirm (see Activity), then try again.';
  if (code === 'NONCE_EXPIRED' || s.includes('nonce too low') || s.includes('invalid nonce') || s.includes('nonce has already been used'))
    return 'This wallet just sent another transaction — refresh and try again in a few seconds.';
  if (s.includes('intrinsic gas too low') || s.includes('gas required exceeds') || s.includes('out of gas'))
    return "The network fee estimate was too low for this transaction. Try again — nothing left your wallet.";
  if (code === 'CALL_EXCEPTION' || s.includes('execution reverted') || s.includes('reverted'))
    return 'The network rejected this transaction (it would fail on-chain). Nothing left your wallet.';
  if (s.includes('no runners') || code === 'NETWORK_ERROR' || code === 'TIMEOUT' || code === 'SERVER_ERROR'
      || s.includes('failed to detect network') || s.includes('could not detect network')
      || s.includes('network error') || s.includes('failed to fetch') || s.includes('timeout') || s.includes('abort'))
    return "Couldn't reach the network. Check your internet connection and try again — nothing left your wallet.";
  if (s.includes('mempool is full') || s.includes('txpool is full') || s.includes('too many'))
    return 'The network is busy right now. Try again in a minute — nothing left your wallet.';

  // Anything else: the node's short reason if it's readable, never the dump.
  const reason = nodeMessage(e).replace(/^[:\s]+/, '');
  if (reason && reason.length <= 120) return `The network didn't accept this transaction: ${reason}.`;
  if (raw && raw.length <= 120 && !/payload|0x[0-9a-f]{40,}/i.test(raw)) return raw;
  return "The network didn't accept this transaction. Nothing left your wallet — try again in a moment.";
}
