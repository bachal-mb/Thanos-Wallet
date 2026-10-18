/**
 * Tokens the wallet's addresses hold beyond its own list, for the Wallet
 * screen (client 2026-10-17: "Show all assets on address but add hide / show
 * button for assets less known assets").
 *
 * lib/token-discovery.ts (a twin of sdk-core portfolio/token-discovery.ts)
 * reads them from the explorers. This keeps the result per address in
 * AsyncStorage so it paints at once, reads again at most every 5 minutes (as
 * Activity's full history read does), one read at a time per address, and
 * checks each EVM token's balance and decimals on its own chain — the
 * explorer's figures stand in only where that read fails, and such a token
 * isn't offered in Send (`verified` stays unset). Never on the balance path:
 * callers run it beside the balance reads, and every failure just keeps
 * what was known.
 *
 * Also the per-wallet choice to show the less-known tokens (hidden by
 * default).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { formatUnits } from 'ethers';
import {
  discoverTokenHoldings, mergeDiscoveredTokens,
  type DiscoveredToken, type DiscoveryAddresses,
} from './token-discovery';

/** A discovered token, and whether its chain confirmed it. */
export interface HeldToken extends DiscoveredToken {
  /** EVM: balance and decimals read on the token's own chain. */
  verified?: boolean;
}

const CACHE_PREFIX = 'token_discovery:v1:';
const SHOW_PREFIX  = 'thanos.show_less_known.v1:';
export const DISCOVERY_EVERY_MS = 5 * 60 * 1000;
/** After a read that reached no network at all (offline), try again this soon. */
const RETRY_MS = 60 * 1000;
/** EVM tokens checked on-chain per read — listed and priced ones come first. */
const VERIFY_MAX = 40;

interface Saved {
  /** When the explorers were last read. */
  at:     number;
  /** The Solana / Cosmos addresses read with it. */
  native: string[];
  tokens: HeldToken[];
}

const memory  = new Map<string, Saved>();
const lastTry = new Map<string, number>();
const running = new Map<string, Promise<HeldToken[]>>();

const keyOf = (evm: string): string => evm.toLowerCase();

async function loadSaved(key: string): Promise<Saved | null> {
  const hit = memory.get(key);
  if (hit) return hit;
  try {
    const raw = await AsyncStorage.getItem(CACHE_PREFIX + key);
    const saved = raw ? (JSON.parse(raw) as Saved) : null;
    if (saved && Array.isArray(saved.tokens) && Array.isArray(saved.native)) {
      memory.set(key, saved);
      return saved;
    }
  } catch { /* unreadable — read again */ }
  return null;
}

/** What the last read found for this address — no network. */
export async function savedHeldTokens(evm: string): Promise<HeldToken[]> {
  if (!evm) return [];
  return (await loadSaved(keyOf(evm)))?.tokens ?? [];
}

/** Confirm EVM tokens on their own chain: balance and decimals from the
 *  token contract. One the chain says is empty now is dropped (the explorer
 *  is behind); one that can't be read keeps the explorer's figures. */
async function verifyOnChain(owner: string, tokens: DiscoveredToken[]): Promise<HeldToken[]> {
  const evm = tokens.filter((t) => t.chain === 'evm' && t.chainId != null).slice(0, VERIFY_MAX);
  if (evm.length === 0) return tokens;
  let reads: Array<{ raw: bigint | null; decimals: number | null }>;
  try {
    const m = await import('./evm-external');
    reads = await m.readErc20Holdings(owner, evm.map((t) => ({ chainId: t.chainId!, address: t.address })));
  } catch {
    return tokens;
  }
  const byKey = new Map(evm.map((t, i) => [t.key, reads[i]]));
  const out: HeldToken[] = [];
  for (const t of tokens) {
    const r = byKey.get(t.key);
    if (!r || (r.raw == null && r.decimals == null)) { out.push(t); continue; }
    if (r.raw === 0n) continue;
    const decimals = r.decimals ?? t.decimals;
    let raw: bigint;
    try { raw = r.raw ?? BigInt(t.rawBalance); } catch { out.push(t); continue; }
    out.push({
      ...t, decimals, rawBalance: raw.toString(),
      balance: formatUnits(raw, decimals).replace(/\.0$/, ''),
      verified: r.raw != null && r.decimals != null,
    });
  }
  return out;
}

/** Held tokens for these addresses: the saved list, read again from the
 *  explorers when it's 5+ minutes old or other Solana / Cosmos addresses are
 *  asked for. A network a read can't reach keeps what was known for it.
 *  Never throws. */
export async function heldTokens(
  addrs: DiscoveryAddresses & { evm: string },
  knownTokens: Array<{ chainId: number; address: string; symbol?: string }>,
): Promise<HeldToken[]> {
  const key = keyOf(addrs.evm);
  const inflight = running.get(key);
  if (inflight) return inflight;
  const saved = await loadSaved(key);
  const now = Date.now();
  const native = [addrs.solana, addrs.cosmos].filter((a): a is string => !!a);
  const fresh = !!saved && saved.at <= now && now - saved.at < DISCOVERY_EVERY_MS
    && native.every((a) => saved.native.includes(a));
  const tried = lastTry.get(key);
  if (fresh || (tried != null && now - tried < RETRY_MS)) return saved?.tokens ?? [];
  if (running.get(key)) return running.get(key)!; // another screen started one meanwhile

  const job = (async (): Promise<HeldToken[]> => {
    lastTry.set(key, Date.now());
    const result = await discoverTokenHoldings(addrs, { knownTokens });
    if (result.read.length === 0) return saved?.tokens ?? [];
    const checked = await verifyOnChain(addrs.evm, result.tokens);
    const tokens = mergeDiscoveredTokens(saved?.tokens ?? [], { ...result, tokens: checked }) as HeldToken[];
    const next: Saved = { at: Date.now(), native, tokens };
    memory.set(key, next);
    AsyncStorage.setItem(CACHE_PREFIX + key, JSON.stringify(next)).catch(() => {});
    return tokens;
  })()
    .catch(() => saved?.tokens ?? [])
    .finally(() => { running.delete(key); });
  running.set(key, job);
  return job;
}

/* ─── Show / hide the less-known ones, per wallet ───────────────────── */

/** Whether this wallet shows its less-known tokens (hidden by default). */
export async function getShowLessKnown(evm: string): Promise<boolean> {
  if (!evm) return false;
  try {
    return (await AsyncStorage.getItem(SHOW_PREFIX + keyOf(evm))) === '1';
  } catch {
    return false;
  }
}

export function setShowLessKnown(evm: string, show: boolean): void {
  if (!evm) return;
  AsyncStorage.setItem(SHOW_PREFIX + keyOf(evm), show ? '1' : '0').catch(() => {});
}
