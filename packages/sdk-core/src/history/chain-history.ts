/**
 * A wallet's full transaction history, read from each network's block
 * explorer.
 *
 * A node can't list an address's past transactions, so Activity only ever
 * knew what the app had sent itself (plus LITHO on Lithosphere). The client
 * asked for every previous transaction (2026-10-15), so this reads each
 * supported network's explorer instead:
 *
 *  - Lithosphere Mainnet: LithoScan (lithoscan.ai), LITHO in and out, paged.
 *    Its token list holds only LITHO so far; LRC-20 transfers get added here
 *    once LithoScan indexes some (GET /api/address/<a>/token-transfers).
 *  - Ethereum, Base, Arbitrum, Polygon, Optimism: Blockscout's v2 API — free,
 *    CORS-open. Base / Arbitrum / Polygon sit behind Cloudflare, which lets
 *    browsers through but challenges curl and server-side fetches.
 *  - Avalanche: Routescan's Etherscan-compatible API (free).
 *  - BNB Chain, Linea: Etherscan API V2, only when a key is configured — no
 *    free explorer API exists for them.
 *  - Bitcoin: mempool.space. Solana: the RPC (getSignaturesForAddress +
 *    getTransaction). Cosmos Hub: the REST tx search.
 *
 * Native transfers and token transfers. Zero-value transfers and flagged or
 * URL-like tokens are dropped (address-poisoning and airdrop spam). Every
 * source is independent: one that can't be reached is listed in `failed`
 * and the others still return.
 *
 * Dependency-free so the mobile app can carry a detached twin
 * (apps/mobile/lib/chain-history.ts). Keep the two identical — the sdk-core
 * test suite runs against both.
 */

export type HistoryChain = 'evm' | 'bitcoin' | 'solana' | 'cosmos';

export interface HistoryAddresses {
  /** 0x… — Lithosphere and every other EVM network. */
  evm?:     string;
  bitcoin?: string;
  solana?:  string;
  /** cosmos1… */
  cosmos?:  string;
}

export interface HistoryRow {
  /** Unique per transfer — the legs of a swap share one hash. */
  id:            string;
  hash:          string;
  chain:         HistoryChain;
  /** EVM networks only. */
  chainId?:      number;
  networkName:   string;
  sym:           string;
  direction:     'in' | 'out';
  /** Human-readable, unsigned. */
  amount:        string;
  counterparty?: string;
  /** Token transfers on EVM networks. */
  tokenAddress?: string;
  /** Epoch ms. */
  ts:            number;
  status:        'pending' | 'confirmed' | 'failed';
  blockNumber?:  number;
  /** Lithosphere's own transaction hash (64 hex, no 0x) — what LithoScan
   *  shows first. `hash` stays the 0x EVM hash, so a send recorded on this
   *  device still matches its explorer row. */
  nativeHash?:   string;
}

export interface HistoryOptions {
  /** Etherscan API V2 key — turns on BNB Chain and Linea. */
  etherscanKey?: string;
  /** 'lithosphere' reads only LithoScan (cheap enough for every refresh);
   *  'all' (default) reads every network. */
  sources?:      'all' | 'lithosphere';
  /** LithoScan pages of 100 to read (default 1). */
  lithoPages?:   number;
  /** Hashes already saved — Solana skips the per-transaction lookup for them. */
  knownHashes?:  Iterable<string>;
  /** Tokens the user added — always shown, like the built-in list. */
  knownTokens?:  Array<{ chainId: number; address: string }>;
  /** Per request (default 15 s). */
  timeoutMs?:    number;
  fetchImpl?:    typeof fetch;
}

export interface HistoryResult {
  /** Newest first, one row per transfer. */
  rows:   HistoryRow[];
  /** Sources that couldn't be read this time, e.g. ['bitcoin', 'base']. */
  failed: string[];
}

const LITHOSCAN = 'https://lithoscan.ai/api';
/** LithoScan pages. Lithosphere addresses are litho1… first and its
 *  transactions go by their native hash; the 0x forms are secondary there
 *  (client 2026-10-15: "make litho1 first class"). */
export const LITHOSCAN_URL = 'https://lithoscan.ai';
/** Works with the native hash or the 0x EVM hash. */
export const lithoscanTxUrl = (hash: string): string => `${LITHOSCAN_URL}/txs/${hash}`;
export const lithoscanAddressUrl = (address: string): string => `${LITHOSCAN_URL}/address/${address}`;

const NATIVE_HASH = /^[0-9A-Fa-f]{64}$/;

/** The native hash of a Lithosphere transaction known by its 0x EVM hash (a
 *  send made on this device), from LithoScan — null when it isn't indexed
 *  yet or LithoScan can't be reached. */
export async function fetchLithoNativeHash(
  evmHash: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(evmHash)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const get = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    const res = await get(`${LITHOSCAN}/txs/${evmHash}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { hash?: unknown } | null;
    return typeof json?.hash === 'string' && NATIVE_HASH.test(json.hash) ? json.hash.toUpperCase() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
const MEMPOOL = 'https://mempool.space/api';
const SOLANA_RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
const COSMOS_REST = 'https://cosmos-rest.publicnode.com';

interface BlockscoutSource { key: string; chainId: number; name: string; sym: string; base: string }
const BLOCKSCOUT: BlockscoutSource[] = [
  { key: 'ethereum', chainId: 1,     name: 'Ethereum', sym: 'ETH', base: 'https://eth.blockscout.com' },
  { key: 'base',     chainId: 8453,  name: 'Base',     sym: 'ETH', base: 'https://base.blockscout.com' },
  { key: 'arbitrum', chainId: 42161, name: 'Arbitrum', sym: 'ETH', base: 'https://arbitrum.blockscout.com' },
  { key: 'polygon',  chainId: 137,   name: 'Polygon',  sym: 'POL', base: 'https://polygon.blockscout.com' },
  { key: 'optimism', chainId: 10,    name: 'Optimism', sym: 'ETH', base: 'https://explorer.optimism.io' },
];

interface EtherscanSource { key: string; chainId: number; name: string; sym: string; api: string; needsKey: boolean }
const ETHERSCAN_STYLE: EtherscanSource[] = [
  { key: 'avalanche', chainId: 43114, name: 'Avalanche', sym: 'AVAX', api: 'https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api', needsKey: false },
  { key: 'bsc',       chainId: 56,    name: 'BNB Chain', sym: 'BNB',  api: 'https://api.etherscan.io/v2/api?chainid=56',    needsKey: true },
  { key: 'linea',     chainId: 59144, name: 'Linea',     sym: 'ETH',  api: 'https://api.etherscan.io/v2/api?chainid=59144', needsKey: true },
];

/** Tokens the wallet lists (apps' EXT_EVM_TOKENS), by chain → contract.
 *  A token transfer shows when its contract is here, or — on Blockscout —
 *  when the token has a market price; airdrop spam has neither. */
const KNOWN_TOKENS: Record<number, Record<string, string>> = {
  1:     { '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC' },
  56:    { '0x55d398326f99059ff775485246999027b3197955': 'USDT', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC' },
  137:   { '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 'USDT', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'USDC' },
  42161: { '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'USDT', '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC' },
  8453:  { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC' },
  10:    { '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': 'USDT', '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 'USDC' },
  43114: { '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7': 'USDT', '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': 'USDC' },
};
/** Symbols address-poisoning fakes copy: from any other contract they're dropped. */
const IMPERSONATED = /^(usdt|usdc|usd₮)$/i;

/** SPL tokens shown in Solana history (others are mostly airdrop spam). */
const SOLANA_TOKENS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
};

/** EVM networks whose history the explorers cover — elsewhere a client
 *  still has to notice receives from balance changes. */
export function historyEvmChainIds(etherscanKey?: string): number[] {
  return [
    9005,
    ...BLOCKSCOUT.map((s) => s.chainId),
    ...ETHERSCAN_STYLE.filter((s) => !s.needsKey || !!etherscanKey).map((s) => s.chainId),
  ];
}

/** bigint base units → decimal string, trailing zeros trimmed. */
export function formatBaseUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const d = Math.max(0, Math.floor(decimals));
  const base = 10n ** BigInt(d);
  const frac = d > 0 ? (v % base).toString().padStart(d, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${(v / base).toString()}${frac ? `.${frac}` : ''}`;
}

interface Ctx {
  fetch:        typeof fetch;
  timeoutMs:    number;
  etherscanKey?: string;
  lithoPages:   number;
  known:        Set<string>;
  /** chainId → lowercase contract addresses always shown. */
  tokens:       Map<number, Set<string>>;
}

async function getJson(ctx: Ctx, url: string, init?: RequestInit, timeoutMs = ctx.timeoutMs): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await ctx.fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const lc = (s: unknown): string => (typeof s === 'string' ? s.toLowerCase() : '');

function big(v: unknown): bigint | null {
  try {
    return BigInt(typeof v === 'number' ? Math.trunc(v) : String(v ?? '0'));
  } catch {
    return null;
  }
}

function msOf(v: unknown): number {
  const t = typeof v === 'number' ? v : Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : Date.now();
}

/** A real token symbol, not a spam lure ("Visit xyz.com", "$ CLAIM …"). */
function plausibleSymbol(s: unknown): s is string {
  return typeof s === 'string'
    && s.length > 0 && s.length <= 12
    && /^[A-Za-z0-9$._+-]+$/.test(s)
    && !/\.(com|io|net|org|xyz|app|site|gift|top)$/i.test(s)
    && !/claim|visit|reward|airdrop|voucher/i.test(s);
}

/** Whether a token transfer belongs in history: a token the wallet knows, or
 *  a priced one that isn't impersonating a known symbol. */
function tokenShown(ctx: Ctx, chainId: number, address: unknown, symbol: string, priced: boolean): boolean {
  const a = lc(address);
  if (!a) return false;
  if (ctx.tokens.get(chainId)?.has(a)) return true;
  return priced && !IMPERSONATED.test(symbol);
}

/* ─── Lithosphere: LithoScan ────────────────────────────────────────── */

async function lithoscan(ctx: Ctx, addr: string): Promise<HistoryRow[]> {
  const me = addr.toLowerCase();
  const out: HistoryRow[] = [];
  for (let page = 0; page < ctx.lithoPages; page++) {
    const json = await getJson(ctx, `${LITHOSCAN}/address/${encodeURIComponent(addr)}/txs?limit=100&offset=${page * 100}`);
    const items: any[] = json?.items ?? json?.txs ?? [];
    for (const t of items) {
      const from = lc(t.evmFromAddr);
      const to = lc(t.evmToAddr);
      if (from !== me && to !== me) continue;
      // Native value transfers only; contract calls carry calldata.
      if ((t.inputData ?? '0x') !== '0x') continue;
      const wei = big(t.value);
      if (wei === null || wei <= 0n) continue;
      const hash = t.evmHash || t.hash || '';
      if (!hash) continue;
      const direction = from === me ? 'out' : 'in';
      out.push({
        id: `${hash}:9005:native:${direction}`,
        hash, chain: 'evm', chainId: 9005, networkName: 'Lithosphere', sym: 'LITHO',
        direction, amount: formatBaseUnits(wei, 18),
        // litho1… first, as LithoScan shows it.
        counterparty: direction === 'out'
          ? (t.toAddr || t.cosmosToAddr || t.evmToAddr)
          : (t.fromAddr || t.cosmosFromAddr || t.evmFromAddr),
        ts: msOf(t.timestamp),
        status: t.success === false ? 'failed' : 'confirmed',
        blockNumber: typeof t.blockHeight === 'number' ? t.blockHeight : undefined,
        ...(typeof t.hash === 'string' && NATIVE_HASH.test(t.hash) ? { nativeHash: t.hash.toUpperCase() } : {}),
      });
    }
    if (!json?.hasMore || items.length === 0) break;
  }
  return out;
}

/* ─── Ethereum, Base, Arbitrum, Polygon, Optimism: Blockscout ───────── */

async function blockscout(ctx: Ctx, src: BlockscoutSource, addr: string): Promise<HistoryRow[]> {
  const me = addr.toLowerCase();
  const [txs, transfers] = await Promise.all([
    getJson(ctx, `${src.base}/api/v2/addresses/${addr}/transactions`),
    getJson(ctx, `${src.base}/api/v2/addresses/${addr}/token-transfers?type=ERC-20`),
  ]);
  const out: HistoryRow[] = [];
  for (const t of (txs?.items ?? []) as any[]) {
    const from = lc(t.from?.hash);
    const to = lc(t.to?.hash);
    if (from !== me && to !== me) continue;
    const wei = big(t.value);
    if (wei === null || wei <= 0n || !t.hash) continue;
    const direction = from === me ? 'out' : 'in';
    const failed = t.status === 'error' || (typeof t.result === 'string' && t.result !== 'success' && t.result !== 'pending');
    if (failed && direction === 'in') continue; // nothing arrived
    out.push({
      id: `${t.hash}:${src.chainId}:native:${direction}`,
      hash: t.hash, chain: 'evm', chainId: src.chainId, networkName: src.name, sym: src.sym,
      direction, amount: formatBaseUnits(wei, 18),
      counterparty: direction === 'out' ? t.to?.hash : t.from?.hash,
      ts: msOf(t.timestamp),
      status: failed ? 'failed' : t.result === 'pending' ? 'pending' : 'confirmed',
      blockNumber: typeof t.block_number === 'number' ? t.block_number : typeof t.block === 'number' ? t.block : undefined,
    });
  }
  for (const x of (transfers?.items ?? []) as any[]) {
    const token = x.token ?? {};
    if (token.reputation && token.reputation !== 'ok') continue;
    if (!plausibleSymbol(token.symbol)) continue;
    if (!tokenShown(ctx, src.chainId, token.address_hash ?? token.address, token.symbol, token.exchange_rate != null)) continue;
    const from = lc(x.from?.hash);
    const to = lc(x.to?.hash);
    if (from !== me && to !== me) continue;
    const value = big(x.total?.value);
    const hash = x.transaction_hash ?? x.tx_hash;
    if (value === null || value <= 0n || !hash) continue;
    const decimals = Number(x.total?.decimals ?? token.decimals ?? 18);
    const tokenAddress: string | undefined = token.address_hash ?? token.address;
    const direction = from === me ? 'out' : 'in';
    out.push({
      id: `${hash}:${src.chainId}:${lc(tokenAddress)}:${direction}:${x.log_index ?? ''}`,
      hash, chain: 'evm', chainId: src.chainId, networkName: src.name, sym: token.symbol,
      direction, amount: formatBaseUnits(value, Number.isFinite(decimals) ? decimals : 18),
      counterparty: direction === 'out' ? x.to?.hash : x.from?.hash,
      tokenAddress,
      ts: msOf(x.timestamp),
      status: 'confirmed',
      blockNumber: typeof x.block_number === 'number' ? x.block_number : undefined,
    });
  }
  return out;
}

/* ─── Avalanche (Routescan), BNB Chain + Linea (Etherscan V2) ────────── */

async function etherscanStyle(ctx: Ctx, src: EtherscanSource, addr: string): Promise<HistoryRow[]> {
  const me = addr.toLowerCase();
  const url = (action: string) =>
    `${src.api}${src.api.includes('?') ? '&' : '?'}module=account&action=${action}&address=${addr}` +
    `&page=1&offset=50&sort=desc${src.needsKey && ctx.etherscanKey ? `&apikey=${encodeURIComponent(ctx.etherscanKey)}` : ''}`;
  const [txs, transfers] = await Promise.all([getJson(ctx, url('txlist')), getJson(ctx, url('tokentx'))]);
  const list = (json: any): any[] => {
    if (Array.isArray(json?.result)) return json.result;
    // status "0" + "No transactions found" is an empty list; anything else
    // (bad key, rate limit) is an error.
    if (/no transactions found/i.test(String(json?.message ?? ''))) return [];
    throw new Error(String(json?.result ?? json?.message ?? 'explorer error'));
  };
  const out: HistoryRow[] = [];
  for (const t of list(txs)) {
    const from = lc(t.from);
    const to = lc(t.to);
    if (from !== me && to !== me) continue;
    const wei = big(t.value);
    if (wei === null || wei <= 0n || !t.hash) continue;
    const direction = from === me ? 'out' : 'in';
    const failed = t.isError === '1' || t.txreceipt_status === '0';
    if (failed && direction === 'in') continue;
    out.push({
      id: `${t.hash}:${src.chainId}:native:${direction}`,
      hash: t.hash, chain: 'evm', chainId: src.chainId, networkName: src.name, sym: src.sym,
      direction, amount: formatBaseUnits(wei, 18),
      counterparty: direction === 'out' ? t.to : t.from,
      ts: Number(t.timeStamp) * 1000 || Date.now(),
      status: failed ? 'failed' : 'confirmed',
      blockNumber: Number(t.blockNumber) || undefined,
    });
  }
  for (const x of list(transfers)) {
    if (!plausibleSymbol(x.tokenSymbol)) continue;
    // No price data here, so only tokens the wallet knows.
    if (!tokenShown(ctx, src.chainId, x.contractAddress, x.tokenSymbol, false)) continue;
    const from = lc(x.from);
    const to = lc(x.to);
    if (from !== me && to !== me) continue;
    const value = big(x.value);
    if (value === null || value <= 0n || !x.hash) continue;
    const direction = from === me ? 'out' : 'in';
    out.push({
      id: `${x.hash}:${src.chainId}:${lc(x.contractAddress)}:${direction}:${x.logIndex ?? ''}`,
      hash: x.hash, chain: 'evm', chainId: src.chainId, networkName: src.name, sym: x.tokenSymbol,
      direction, amount: formatBaseUnits(value, Number(x.tokenDecimal) || 0),
      counterparty: direction === 'out' ? x.to : x.from,
      tokenAddress: x.contractAddress,
      ts: Number(x.timeStamp) * 1000 || Date.now(),
      status: 'confirmed',
      blockNumber: Number(x.blockNumber) || undefined,
    });
  }
  return out;
}

/* ─── Bitcoin: mempool.space ────────────────────────────────────────── */

async function bitcoin(ctx: Ctx, addr: string): Promise<HistoryRow[]> {
  const me = addr.toLowerCase();
  const txs: any[] = await getJson(ctx, `${MEMPOOL}/address/${encodeURIComponent(addr)}/txs`);
  const out: HistoryRow[] = [];
  for (const t of Array.isArray(txs) ? txs : []) {
    let fromMe = 0n;
    let toMe = 0n;
    let toOthers = 0n;
    let other: string | undefined;
    for (const i of t.vin ?? []) {
      if (lc(i.prevout?.scriptpubkey_address) === me) fromMe += big(i.prevout?.value) ?? 0n;
      else other ??= i.prevout?.scriptpubkey_address;
    }
    for (const o of t.vout ?? []) {
      const v = big(o.value) ?? 0n;
      if (lc(o.scriptpubkey_address) === me) toMe += v;
      else { toOthers += v; if (fromMe > 0n) other = o.scriptpubkey_address ?? other; }
    }
    let direction: 'in' | 'out';
    let sats: bigint;
    if (fromMe > 0n) {
      if (toOthers <= 0n) continue; // moved coins to itself
      direction = 'out';
      sats = toOthers; // what left the wallet, without fee and change
    } else if (toMe > 0n) {
      direction = 'in';
      sats = toMe;
    } else continue;
    const confirmed = !!t.status?.confirmed;
    out.push({
      id: `${t.txid}:btc:${direction}`,
      hash: t.txid, chain: 'bitcoin', networkName: 'Bitcoin', sym: 'BTC',
      direction, amount: formatBaseUnits(sats, 8),
      counterparty: other,
      ts: t.status?.block_time ? t.status.block_time * 1000 : Date.now(),
      status: confirmed ? 'confirmed' : 'pending',
      blockNumber: typeof t.status?.block_height === 'number' ? t.status.block_height : undefined,
    });
  }
  return out;
}

/* ─── Solana: RPC ───────────────────────────────────────────────────── */

async function solanaRpc(ctx: Ctx, method: string, params: unknown[]): Promise<any> {
  let lastErr: unknown = new Error('Solana RPC unreachable');
  for (const url of SOLANA_RPCS) {
    try {
      const json = await getJson(ctx, url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (json && 'result' in json) return json.result;
      lastErr = new Error(json?.error?.message ?? 'Solana RPC error');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Rows for one parsed transaction: SOL moved (fee left out) and USDC/USDT. */
function solanaRows(sig: string, me: string, tx: any): HistoryRow[] {
  const meta = tx?.meta;
  if (!meta) return [];
  const keys: string[] = (tx.transaction?.message?.accountKeys ?? []).map((k: any) => (typeof k === 'string' ? k : k?.pubkey));
  const ts = typeof tx.blockTime === 'number' ? tx.blockTime * 1000 : Date.now();
  const status: HistoryRow['status'] = meta.err ? 'failed' : 'confirmed';
  const out: HistoryRow[] = [];
  const idx = keys.indexOf(me);
  if (idx >= 0) {
    let delta = BigInt(meta.postBalances?.[idx] ?? 0) - BigInt(meta.preBalances?.[idx] ?? 0);
    if (idx === 0) delta += BigInt(meta.fee ?? 0); // the fee payer's change includes the fee
    if (delta !== 0n) {
      const direction = delta > 0n ? 'in' : 'out';
      out.push({
        id: `${sig}:SOL:${direction}`, hash: sig, chain: 'solana', networkName: 'Solana', sym: 'SOL',
        direction, amount: formatBaseUnits(delta < 0n ? -delta : delta, 9), ts, status,
      });
    }
  }
  for (const [mint, sym] of Object.entries(SOLANA_TOKENS)) {
    const sum = (list: any[] | undefined): bigint => (list ?? [])
      .filter((b) => b?.owner === me && b?.mint === mint)
      .reduce<bigint>((s, b) => s + (big(b.uiTokenAmount?.amount) ?? 0n), 0n);
    const delta = sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
    if (delta === 0n) continue;
    const decimals = Number(
      [...(meta.postTokenBalances ?? []), ...(meta.preTokenBalances ?? [])].find((b: any) => b?.mint === mint)?.uiTokenAmount?.decimals ?? 6,
    );
    const direction = delta > 0n ? 'in' : 'out';
    out.push({
      id: `${sig}:${sym}:${direction}`, hash: sig, chain: 'solana', networkName: 'Solana', sym,
      direction, amount: formatBaseUnits(delta < 0n ? -delta : delta, decimals), ts, status,
    });
  }
  return out;
}

async function solana(ctx: Ctx, addr: string): Promise<HistoryRow[]> {
  const sigs: any[] = await solanaRpc(ctx, 'getSignaturesForAddress', [addr, { limit: 20 }]);
  // Public RPCs allow one getTransaction per request; skip what's saved and
  // failed attempts (nothing moved), and look the rest up a few at a time.
  const todo = (Array.isArray(sigs) ? sigs : []).filter((s) => s?.signature && !s.err && !ctx.known.has(s.signature));
  const out: HistoryRow[] = [];
  for (let i = 0; i < todo.length; i += 3) {
    const batch = todo.slice(i, i + 3);
    const txs = await Promise.allSettled(batch.map((s) =>
      solanaRpc(ctx, 'getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])));
    txs.forEach((r, j) => { if (r.status === 'fulfilled') out.push(...solanaRows(batch[j].signature, addr, r.value)); });
  }
  return out;
}

/* ─── Cosmos Hub: REST tx search ────────────────────────────────────── */

async function cosmos(ctx: Ctx, addr: string): Promise<HistoryRow[]> {
  const search = (query: string) =>
    // Event searches take several seconds on public nodes.
    getJson(ctx, `${COSMOS_REST}/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(query)}&order_by=ORDER_BY_DESC&limit=30&page=1`, undefined, Math.max(ctx.timeoutMs, 30_000));
  const [sent, received] = await Promise.all([
    search(`message.sender='${addr}'`),
    search(`transfer.recipient='${addr}'`),
  ]);
  const out: HistoryRow[] = [];
  for (const r of [...(sent?.tx_responses ?? []), ...(received?.tx_responses ?? [])] as any[]) {
    (r.tx?.body?.messages ?? []).forEach((m: any, n: number) => {
      if (m?.['@type'] !== '/cosmos.bank.v1beta1.MsgSend') return;
      if (m.from_address !== addr && m.to_address !== addr) return;
      const uatom = (m.amount ?? [])
        .filter((c: any) => c?.denom === 'uatom')
        .reduce((s: bigint, c: any) => s + (big(c.amount) ?? 0n), 0n);
      if (uatom <= 0n) return;
      const direction = m.from_address === addr ? 'out' : 'in';
      if (r.code && direction === 'in') return;
      out.push({
        id: `${r.txhash}:ATOM:${direction}:${n}`,
        hash: r.txhash, chain: 'cosmos', networkName: 'Cosmos Hub', sym: 'ATOM',
        direction, amount: formatBaseUnits(uatom, 6),
        counterparty: direction === 'out' ? m.to_address : m.from_address,
        ts: msOf(r.timestamp),
        status: r.code ? 'failed' : 'confirmed',
        blockNumber: Number(r.height) || undefined,
      });
    });
  }
  return out;
}

/* ─── Entry point ───────────────────────────────────────────────────── */

export async function fetchChainHistory(addrs: HistoryAddresses, opts: HistoryOptions = {}): Promise<HistoryResult> {
  const ctx: Ctx = {
    // Wrapped: calling a bare fetch as ctx.fetch() throws "Illegal invocation".
    fetch: opts.fetchImpl ?? (((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch),
    timeoutMs: opts.timeoutMs ?? 15_000,
    etherscanKey: opts.etherscanKey || undefined,
    lithoPages: Math.max(1, Math.floor(opts.lithoPages ?? 1)),
    known: new Set(opts.knownHashes ?? []),
    tokens: new Map(Object.entries(KNOWN_TOKENS).map(([id, list]) => [Number(id), new Set(Object.keys(list))])),
  };
  for (const t of opts.knownTokens ?? []) {
    if (!ctx.tokens.has(t.chainId)) ctx.tokens.set(t.chainId, new Set());
    ctx.tokens.get(t.chainId)!.add(lc(t.address));
  }
  const all = (opts.sources ?? 'all') === 'all';
  const jobs: Array<[string, () => Promise<HistoryRow[]>]> = [];
  const evm = addrs.evm;
  if (evm) {
    jobs.push(['lithosphere', () => lithoscan(ctx, evm)]);
    if (all) {
      for (const s of BLOCKSCOUT) jobs.push([s.key, () => blockscout(ctx, s, evm)]);
      for (const s of ETHERSCAN_STYLE) if (!s.needsKey || ctx.etherscanKey) jobs.push([s.key, () => etherscanStyle(ctx, s, evm)]);
    }
  }
  if (all && addrs.bitcoin) { const a = addrs.bitcoin; jobs.push(['bitcoin', () => bitcoin(ctx, a)]); }
  if (all && addrs.solana) { const a = addrs.solana; jobs.push(['solana', () => solana(ctx, a)]); }
  if (all && addrs.cosmos) { const a = addrs.cosmos; jobs.push(['cosmos', () => cosmos(ctx, a)]); }

  const settled = await Promise.allSettled(jobs.map(([, run]) => run()));
  const byId = new Map<string, HistoryRow>();
  const failed: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'rejected') { failed.push(jobs[i][0]); return; }
    for (const row of r.value) if (!byId.has(row.id)) byId.set(row.id, row);
  });
  return { rows: [...byId.values()].sort((a, b) => b.ts - a.ts), failed };
}
