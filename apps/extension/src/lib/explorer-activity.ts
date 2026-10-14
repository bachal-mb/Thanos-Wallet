/**
 * Native LITHO in and out on Lithosphere Mainnet, from its explorer
 * (lithoscan.ai) — extension.
 *
 * Native value transfers emit no logs, so nothing log-based reports them; the
 * explorer indexes full transactions at GET /api/address/<0x|litho1>/txs
 * (same API the mobile and desktop apps read; CORS-open). Rows come back in
 * the local-activity shape and are saved there (mergeExplorerRows), which
 * keeps them after they leave the explorer's latest page and settles a
 * matching pending send.
 */
import { formatUnits } from 'ethers';
import type { LocalTx } from './local-activity';

const MAINNET_API = 'https://lithoscan.ai/api';

interface ExplorerTx {
  hash?: string;
  evmHash?: string;
  value?: string;
  inputData?: string;
  timestamp?: string;
  evmFromAddr?: string;
  evmToAddr?: string;
  success?: boolean;
}

/** Recent native-LITHO transfers involving `address`, or null when the
 *  explorer couldn't be reached. */
export async function fetchMainnetNativeActivity(address: string, timeoutMs = 15_000): Promise<LocalTx[] | null> {
  if (!address) return [];
  const me = address.toLowerCase();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${MAINNET_API}/address/${encodeURIComponent(address)}/txs?limit=50`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { items?: ExplorerTx[]; txs?: ExplorerTx[] } | null;
    const out: LocalTx[] = [];
    // Per-address list since the Mainnet launch (2026-10-14): /api/txs
    // now ignores ?address= and returns everyone's latest transactions.
    for (const t of json?.items ?? json?.txs ?? []) {
      const from = (t.evmFromAddr ?? '').toLowerCase();
      const to = (t.evmToAddr ?? '').toLowerCase();
      if (from !== me && to !== me) continue;
      // Native value transfers only; token transfers carry calldata.
      if ((t.inputData ?? '0x') !== '0x') continue;
      let wei = 0n;
      try { wei = BigInt(t.value ?? '0'); } catch { continue; }
      if (wei <= 0n) continue;
      const hash = t.evmHash || t.hash || '';
      if (!hash) continue;
      const ts = t.timestamp ? Date.parse(t.timestamp) : NaN;
      out.push({
        hash,
        chain: 'evm',
        chainId: 9005,
        networkName: 'Lithosphere',
        sym: 'LITHO',
        label: to === me ? 'Received' : 'Sent',
        amount: formatUnits(wei, 18),
        ts: Number.isFinite(ts) ? ts : Date.now(),
        status: t.success === false ? 'failed' : 'confirmed',
      });
    }
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
