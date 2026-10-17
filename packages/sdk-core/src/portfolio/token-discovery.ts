/**
 * Every token a wallet's addresses actually hold, read from block explorers
 * and public nodes — not only the tokens in the wallet's own list.
 *
 * Balances used to be read only for listed tokens, so a token sent from
 * elsewhere never showed (client 2026-10-17: LAX sent to the address didn't
 * appear — "Show all assets on address but add hide / show button for …
 * less known assets"). Sources, all free and CORS-open:
 *
 *  - Ethereum, Optimism, Avalanche: Routescan's cross-chain holdings — one
 *    request covers all three (paged, 100 a page).
 *  - Ethereum, Optimism, Base, Arbitrum, Polygon: Blockscout v2 token
 *    balances, which also carry a market price (exchange_rate), a reputation
 *    flag and a logo. On Ethereum and Optimism both are read and merged —
 *    Blockscout's price and flag win. Base / Arbitrum / Polygon sit behind
 *    Cloudflare, which lets browsers through but may challenge other clients:
 *    a source that can't be read is listed in `failed`, never thrown.
 *  - Solana: the RPC's getTokenAccountsByOwner (SPL Token and Token-2022).
 *  - Cosmos Hub: the bank balances REST endpoint; IBC denoms are named from
 *    their trace.
 *  - BNB Chain, Linea, Lithosphere: no free source lists holdings there
 *    (LithoScan's address token list is empty so far), so their tokens come
 *    from the wallet's list and user-added tokens only. A source is a row in
 *    EVM_NETWORKS plus a reader — e.g. an Etherscan key — without changing
 *    callers.
 *
 * Every token held (balance above zero) is classed:
 *  - spam — flagged by the explorer, a URL-like or "claim / visit / airdrop"
 *    symbol or name, or a look-alike (USDT / USDC, the network's own coin,
 *    or a listed token's symbol on another contract): never returned — the
 *    rules Activity's history uses (history/chain-history.ts), plus names.
 *  - well known (`wellKnown`) — in the wallet's list or user-added, or priced
 *    by the explorer and not flagged: shown like a listed token.
 *  - less known — anything else held: callers keep these hidden until the
 *    user asks to see them.
 *
 * Dependency-free so the mobile app can carry a detached twin
 * (apps/mobile/lib/token-discovery.ts). Keep the two identical — the sdk-core
 * test suite runs against both.
 */

export type DiscoveryChain = 'evm' | 'solana' | 'cosmos';

export interface DiscoveryAddresses {
  /** 0x… — every EVM network. */
  evm?:    string;
  solana?: string;
  /** cosmos1… */
  cosmos?: string;
}

export type DiscoverySource = 'routescan' | 'blockscout' | 'solana-rpc' | 'cosmos-rest';

export interface DiscoveredToken {
  /** Unique per token: `<chainId or chain>:<address>`. */
  key:          string;
  chain:        DiscoveryChain;
  /** EVM networks only. */
  chainId?:     number;
  /** 'ethereum', 'base', …, 'solana', 'cosmos' — as in `read` / `failed`. */
  network:      string;
  networkName:  string;
  /** EVM contract (lowercase), SPL mint, or Cosmos denom. */
  address:      string;
  symbol:       string;
  name:         string;
  decimals:     number;
  /** Human-readable, exact. */
  balance:      string;
  /** Base units. */
  rawBalance:   string;
  source:       DiscoverySource;
  /** The explorer gave a market price. */
  priced:       boolean;
  /** USD per token, when priced. */
  priceUsd?:    number;
  /** The explorer's flag ('ok', 'scam', …), when it gave one. */
  reputation?:  string;
  logo?:        string;
  /** In the wallet's own list (built in or user-added). */
  known:        boolean;
  /** Shown by default: known, or priced and not flagged. The rest are less
   *  known — hidden until the user asks. */
  wellKnown:    boolean;
}

export interface DiscoveryOptions {
  /** Tokens the wallet lists, built in or user-added — always well known. A
   *  symbol, when given, also marks another contract using it on that
   *  network as a look-alike. */
  knownTokens?:    Array<{ chainId: number; address: string; symbol?: string }>;
  /** EVM networks to read (default: every one a source covers). */
  chainIds?:       number[];
  /** Routescan pages of 100 to read (default 3). */
  routescanPages?: number;
  /** At most this many tokens (default 100): listed ones first, then priced
   *  by value, then the rest. */
  maxTokens?:      number;
  /** Per request (default 15 s). */
  timeoutMs?:      number;
  fetchImpl?:      typeof fetch;
}

export interface DiscoveryResult {
  /** Listed first, then well known by value, then less known. */
  tokens: DiscoveredToken[];
  /** Networks read this time, e.g. ['ethereum', 'solana']. */
  read:   string[];
  /** Networks that couldn't be read this time, e.g. ['base']. */
  failed: string[];
}

const ROUTESCAN = 'https://api.routescan.io';
const SOLANA_RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
const COSMOS_REST = 'https://cosmos-rest.publicnode.com';

interface EvmNetwork { key: string; chainId: number; name: string; native: string; blockscout?: string; routescan?: boolean }
/** EVM networks some free source lists holdings for. */
const EVM_NETWORKS: EvmNetwork[] = [
  { key: 'ethereum',  chainId: 1,     name: 'Ethereum',  native: 'ETH',  blockscout: 'https://eth.blockscout.com',   routescan: true },
  { key: 'optimism',  chainId: 10,    name: 'Optimism',  native: 'ETH',  blockscout: 'https://explorer.optimism.io', routescan: true },
  { key: 'avalanche', chainId: 43114, name: 'Avalanche', native: 'AVAX',                                             routescan: true },
  { key: 'base',      chainId: 8453,  name: 'Base',      native: 'ETH',  blockscout: 'https://base.blockscout.com' },
  { key: 'arbitrum',  chainId: 42161, name: 'Arbitrum',  native: 'ETH',  blockscout: 'https://arbitrum.blockscout.com' },
  { key: 'polygon',   chainId: 137,   name: 'Polygon',   native: 'POL',  blockscout: 'https://polygon.blockscout.com' },
];
const NATIVE_SYMBOL = new Map(EVM_NETWORKS.map((n) => [n.chainId, n.native]));

/** Tokens the wallets list (apps' EXT_EVM_TOKENS), by chain → contract →
 *  symbol. Callers add their own and user-added ones via `knownTokens`. */
const KNOWN_TOKENS: Record<number, Record<string, string>> = {
  1:     { '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
           '0xbd79b7db6f70979df7f4124e161eb3586085d140': 'LAX', '0x1c3547dfa9ce7acd9c54ae49244575fa65bc75e2': 'IMAGE',
           '0x75d86078625d1e2f612de2627d34c7bc411c18b8': 'AGII', '0x528605856a9eb9567688b0e912ed6961522a74d4': 'MUSA',
           '0xc36983d3d9d379ddfb306dfb919099cb6730e355': 'COLLE' },
  56:    { '0x55d398326f99059ff775485246999027b3197955': 'USDT', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC',
           '0x328fd053c4bb968875afd9ad0af36fcf4a0bdda9': 'AGII', '0x528605856a9eb9567688b0e912ed6961522a74d4': 'MUSA',
           '0xaeb63742f2c7dd1538bbe2285b6789017a06b58b': 'COLLE', '0x11125e44843170467a7955d29776d63760ea4b6e': 'LAX' },
  137:   { '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 'USDT', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'USDC' },
  42161: { '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'USDT', '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC' },
  8453:  { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC', '0xe7645444eb4e8e04d886c7038dd0152d331d3680': 'LAX' },
  10:    { '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': 'USDT', '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 'USDC' },
  43114: { '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7': 'USDT', '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': 'USDC' },
};
/** Symbols address-poisoning fakes copy: from any other contract they're spam. */
const IMPERSONATED = /^(usdt|usdc|usd₮)$/i;

/** SPL mints with a name; only USDC / USDT count as the wallet's own. */
const SOLANA_TOKENS: Record<string, { symbol: string; name: string; known: boolean }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', name: 'USD Coin',    known: true },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', name: 'Tether USD',  known: true },
  So11111111111111111111111111111111111111112:  { symbol: 'WSOL', name: 'Wrapped SOL', known: false },
};
const SPL_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

/** EVM networks this can list holdings for — elsewhere a client relies on
 *  its own token list. */
export function discoveryEvmChainIds(): number[] {
  return EVM_NETWORKS.map((n) => n.chainId);
}

/* ─── Helpers ───────────────────────────────────────────────────────── */

interface Ctx {
  fetch:     typeof fetch;
  timeoutMs: number;
  /** chainId → lowercase contract → symbol ('' when not given). */
  known:     Map<number, Map<string, string>>;
}

async function getJson(ctx: Ctx, url: string, init?: RequestInit): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ctx.timeoutMs);
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

function decimalsOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 36 ? n : null;
}

/** bigint base units → decimal string, trailing zeros trimmed. */
function unitsToDecimal(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = decimals > 0 ? (value % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${(value / base).toString()}${frac ? `.${frac}` : ''}`;
}

/** A real token symbol, not a spam lure ("Visit xyz.com", "$ CLAIM …"). */
function plausibleSymbol(s: unknown): s is string {
  return typeof s === 'string'
    && s.length > 0 && s.length <= 12
    && /^[A-Za-z0-9$._+-]+$/.test(s)
    && !/\.(com|io|net|org|xyz|app|site|gift|top)$/i.test(s)
    && !/claim|visit|reward|airdrop|voucher/i.test(s);
}

/** A name that's an ad for a website or a "claim" lure. */
function spamName(s: unknown): boolean {
  return typeof s === 'string' && (
    /https?:|www\.|t\.me\//i.test(s)
    || /\b[a-z0-9-]+\.(com|io|net|org|xyz|app|site|gift|top|vip|cc|link|info|club|live|online|fun|lol)\b/i.test(s)
    || /claim|visit|airdrop|voucher/i.test(s));
}

const shortId = (s: string): string => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

/** A holding as a source reports it, before it's classed. */
interface Holding {
  chain:       DiscoveryChain;
  chainId?:    number;
  network:     string;
  networkName: string;
  address:     string;
  symbol:      string;
  name:        string;
  decimals:    number;
  raw:         bigint;
  source:      DiscoverySource;
  priceUsd?:   number;
  reputation?: string;
  logo?:       string;
  /** Solana / Cosmos: whether it's one of the wallet's own (EVM: from ctx). */
  known?:      boolean;
}

/** The token as returned, or null when it's spam or nothing is held. */
function classify(ctx: Ctx, h: Holding): DiscoveredToken | null {
  if (h.raw <= 0n) return null;
  const address = h.chain === 'evm' ? h.address.toLowerCase() : h.address;
  const listed = h.chainId != null ? ctx.known.get(h.chainId) : undefined;
  const known = h.chain === 'evm' ? !!listed?.has(address) : !!h.known;
  if (!known) {
    if (h.reputation && h.reputation !== 'ok') return null; // flagged by the explorer
    // URL / claim lures. A Solana or IBC token without a name is shown by
    // its id ("47vY…hL49"), which isn't a symbol to judge.
    const namedById = h.chain !== 'evm' && h.symbol.includes('…');
    if ((!namedById && !plausibleSymbol(h.symbol)) || spamName(h.name)) return null;
    if (h.chain === 'evm') {
      // Fake USDT / USDC, the network's own coin, or a listed token's symbol
      // on another contract.
      const sym = h.symbol.toUpperCase();
      if (IMPERSONATED.test(h.symbol) || sym === NATIVE_SYMBOL.get(h.chainId!)) return null;
      for (const s of listed?.values() ?? []) if (s && s.toUpperCase() === sym) return null;
    }
  }
  const priced = h.priceUsd != null && Number.isFinite(h.priceUsd) && h.priceUsd > 0;
  return {
    key: `${h.chainId ?? h.chain}:${address}`,
    chain: h.chain,
    ...(h.chainId != null ? { chainId: h.chainId } : {}),
    network: h.network, networkName: h.networkName,
    address, symbol: h.symbol, name: h.name || h.symbol, decimals: h.decimals,
    balance: unitsToDecimal(h.raw, h.decimals), rawBalance: h.raw.toString(),
    source: h.source, priced,
    ...(priced ? { priceUsd: h.priceUsd } : {}),
    ...(h.reputation ? { reputation: h.reputation } : {}),
    ...(h.logo ? { logo: h.logo } : {}),
    known,
    wellKnown: known || (priced && (!h.reputation || h.reputation === 'ok')),
  };
}

const usdOf = (t: DiscoveredToken): number => (t.priceUsd ? Number(t.balance) * t.priceUsd : 0);
const NETWORK_ORDER = [...EVM_NETWORKS.map((n) => n.key), 'solana', 'cosmos'];

/** Listed first, then well known by value, then less known; each by network. */
function sortTokens(tokens: DiscoveredToken[]): DiscoveredToken[] {
  const rank = (t: DiscoveredToken) => (t.known ? 0 : t.wellKnown ? 1 : 2);
  return [...tokens].sort((a, b) =>
    rank(a) - rank(b)
    || usdOf(b) - usdOf(a)
    || NETWORK_ORDER.indexOf(a.network) - NETWORK_ORDER.indexOf(b.network)
    || a.symbol.localeCompare(b.symbol));
}

/* ─── Ethereum, Optimism, Avalanche: Routescan ──────────────────────── */

async function routescan(ctx: Ctx, addr: string, pages: number, nets: EvmNetwork[]): Promise<Holding[]> {
  const byChain = new Map(nets.map((n) => [n.chainId, n]));
  const out: Holding[] = [];
  let url: string | null = `${ROUTESCAN}/v2/network/mainnet/evm/all/address/${addr}/erc20-holdings?limit=100`;
  for (let page = 0; page < pages && url; page++) {
    const json = await getJson(ctx, url);
    for (const x of (json?.items ?? []) as any[]) {
      const net = byChain.get(Number(x.chainId));
      const decimals = decimalsOf(x.tokenDecimals);
      const raw = big(x.tokenQuantity);
      if (!net || decimals === null || raw === null || typeof x.tokenAddress !== 'string') continue;
      // Routescan's own tokenPrice isn't used: it carries no spam flag, so a
      // priced airdrop would pass as well known.
      out.push({
        chain: 'evm', chainId: net.chainId, network: net.key, networkName: net.name,
        address: x.tokenAddress, symbol: String(x.tokenSymbol ?? ''), name: String(x.tokenName ?? ''),
        decimals, raw, source: 'routescan',
      });
    }
    const next: unknown = json?.link?.next;
    url = typeof next === 'string' && next.startsWith('/') ? `${ROUTESCAN}${next}` : null;
  }
  return out;
}

/* ─── Ethereum, Optimism, Base, Arbitrum, Polygon: Blockscout ───────── */

async function blockscout(ctx: Ctx, net: EvmNetwork, addr: string): Promise<Holding[]> {
  const json = await getJson(ctx, `${net.blockscout}/api/v2/addresses/${addr}/token-balances`);
  if (!Array.isArray(json)) throw new Error('unexpected response');
  const out: Holding[] = [];
  for (const x of json as any[]) {
    const token = x?.token ?? {};
    if (token.type !== 'ERC-20') continue; // NFTs aren't balances
    const decimals = decimalsOf(token.decimals);
    const raw = big(x.value);
    const address = token.address_hash ?? token.address;
    if (decimals === null || raw === null || typeof address !== 'string') continue;
    const rate = token.exchange_rate != null ? Number(token.exchange_rate) : NaN;
    out.push({
      chain: 'evm', chainId: net.chainId, network: net.key, networkName: net.name,
      address, symbol: String(token.symbol ?? ''), name: String(token.name ?? ''),
      decimals, raw, source: 'blockscout',
      ...(Number.isFinite(rate) && rate > 0 ? { priceUsd: rate } : {}),
      ...(typeof token.reputation === 'string' ? { reputation: token.reputation } : {}),
      ...(typeof token.icon_url === 'string' && /^https:\/\//.test(token.icon_url) ? { logo: token.icon_url } : {}),
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

async function solana(ctx: Ctx, owner: string): Promise<Holding[]> {
  // SPL Token must answer; Token-2022 is best-effort.
  const [classic, t22] = await Promise.allSettled(SPL_PROGRAMS.map((programId) =>
    solanaRpc(ctx, 'getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed' }])));
  if (classic.status === 'rejected') throw classic.reason;
  const accounts: any[] = [
    ...(classic.value?.value ?? []),
    ...(t22.status === 'fulfilled' ? t22.value?.value ?? [] : []),
  ];
  // One mint can sit in several accounts.
  const byMint = new Map<string, { raw: bigint; decimals: number }>();
  for (const a of accounts) {
    const info = a?.account?.data?.parsed?.info;
    const mint = info?.mint;
    const decimals = decimalsOf(info?.tokenAmount?.decimals);
    const raw = big(info?.tokenAmount?.amount);
    // 0 decimals is an NFT (a supply of one), not a balance.
    if (typeof mint !== 'string' || decimals === null || decimals === 0 || raw === null || raw <= 0n) continue;
    const hit = byMint.get(mint);
    byMint.set(mint, { raw: (hit?.raw ?? 0n) + raw, decimals });
  }
  return [...byMint].map(([mint, { raw, decimals }]): Holding => {
    const named = SOLANA_TOKENS[mint];
    return {
      chain: 'solana', network: 'solana', networkName: 'Solana', address: mint,
      symbol: named?.symbol ?? shortId(mint), name: named?.name ?? 'Unknown token',
      decimals, raw, source: 'solana-rpc', known: !!named?.known,
    };
  });
}

/* ─── Cosmos Hub: bank balances ─────────────────────────────────────── */

/** A denom's symbol and decimals: micro (u…) is 6, atto (a…) 18 — the
 *  Cosmos convention; anything else is shown in base units. */
function denomLabel(base: string): { symbol: string; decimals: number } {
  const last = base.split('/').pop() || base;
  if (/^u[a-z][a-z0-9]{1,11}$/.test(last)) return { symbol: last.slice(1).toUpperCase(), decimals: 6 };
  if (/^a[a-z][a-z0-9]{2,11}$/.test(last)) return { symbol: last.slice(1).toUpperCase(), decimals: 18 };
  return { symbol: plausibleSymbol(last) ? last.toUpperCase() : shortId(base), decimals: 0 };
}

/** The base denom behind an IBC voucher (`ibc/<hash>`), or null. */
async function ibcBase(ctx: Ctx, hash: string): Promise<string | null> {
  try {
    const json = await getJson(ctx, `${COSMOS_REST}/ibc/apps/transfer/v1/denoms/${hash}`);
    if (typeof json?.denom?.base === 'string') return json.denom.base;
  } catch { /* older nodes only have denom_traces */ }
  try {
    const json = await getJson(ctx, `${COSMOS_REST}/ibc/apps/transfer/v1/denom_traces/${hash}`);
    if (typeof json?.denom_trace?.base_denom === 'string') return json.denom_trace.base_denom;
  } catch { /* named by the denom itself */ }
  return null;
}

/** IBC denoms looked up per read — the rest are named by their hash. */
const IBC_LOOKUPS = 10;

async function cosmos(ctx: Ctx, addr: string): Promise<Holding[]> {
  const json = await getJson(ctx, `${COSMOS_REST}/cosmos/bank/v1beta1/balances/${encodeURIComponent(addr)}?pagination.limit=200`);
  const coins = ((json?.balances ?? []) as any[])
    .filter((c) => typeof c?.denom === 'string' && c.denom !== 'uatom'); // ATOM is the native coin
  let lookups = 0;
  const list = await Promise.all(coins.map(async (c): Promise<Holding | null> => {
    const denom: string = c.denom;
    const ibc = /^ibc\/([0-9A-Fa-f]{64})$/.exec(denom);
    const base = ibc ? (lookups++ < IBC_LOOKUPS ? await ibcBase(ctx, ibc[1]) : null) : denom;
    // Lures live in the denom itself (factory/…/claim-at-x.com).
    if (spamName(denom) || (base && spamName(base))) return null;
    const { symbol, decimals } = base ? denomLabel(base) : { symbol: shortId(denom), decimals: 0 };
    return {
      chain: 'cosmos', network: 'cosmos', networkName: 'Cosmos Hub', address: denom,
      symbol, name: base ? (ibc ? `${symbol} (IBC)` : symbol) : 'IBC token',
      decimals, raw: big(c.amount) ?? 0n, source: 'cosmos-rest',
    };
  }));
  return list.filter((h): h is Holding => h !== null);
}

/* ─── Entry point ───────────────────────────────────────────────────── */

export async function discoverTokenHoldings(addrs: DiscoveryAddresses, opts: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const ctx: Ctx = {
    // Wrapped: calling a bare fetch as ctx.fetch() throws "Illegal invocation".
    fetch: opts.fetchImpl ?? (((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch),
    timeoutMs: opts.timeoutMs ?? 15_000,
    known: new Map(Object.entries(KNOWN_TOKENS).map(([id, list]) => [Number(id), new Map(Object.entries(list))])),
  };
  for (const t of opts.knownTokens ?? []) {
    if (!ctx.known.has(t.chainId)) ctx.known.set(t.chainId, new Map());
    const list = ctx.known.get(t.chainId)!;
    const a = lc(t.address);
    if (a) list.set(a, t.symbol ?? list.get(a) ?? '');
  }

  const read: string[] = [];
  const failed: string[] = [];
  const holdings: Holding[] = [];
  const jobs: Promise<void>[] = [];

  const evm = addrs.evm;
  if (evm) {
    const wanted = opts.chainIds ? new Set(opts.chainIds) : null;
    const nets = EVM_NETWORKS.filter((n) => !wanted || wanted.has(n.chainId));
    const pages = Math.max(1, Math.floor(opts.routescanPages ?? 3));
    jobs.push((async () => {
      const [rs, ...bs] = await Promise.allSettled([
        nets.some((n) => n.routescan) ? routescan(ctx, evm, pages, nets.filter((n) => n.routescan)) : Promise.resolve([]),
        ...nets.map((n) => (n.blockscout ? blockscout(ctx, n, evm) : Promise.reject(new Error('no Blockscout')))),
      ]);
      nets.forEach((n, i) => {
        const b = bs[i];
        const viaRoutescan = n.routescan && rs.status === 'fulfilled';
        if (b.status === 'rejected' && !viaRoutescan) { failed.push(n.key); return; }
        read.push(n.key);
        // Both read: one entry per contract, Blockscout's price and flag win.
        const merged = new Map<string, Holding>();
        if (rs.status === 'fulfilled') for (const h of rs.value) if (h.chainId === n.chainId) merged.set(lc(h.address), h);
        if (b.status === 'fulfilled') for (const h of b.value) merged.set(lc(h.address), h);
        holdings.push(...merged.values());
      });
    })());
  }
  const solAddr = addrs.solana;
  if (solAddr) {
    jobs.push(solana(ctx, solAddr).then(
      (list) => { read.push('solana'); holdings.push(...list); },
      () => { failed.push('solana'); },
    ));
  }
  const atomAddr = addrs.cosmos;
  if (atomAddr) {
    jobs.push(cosmos(ctx, atomAddr).then(
      (list) => { read.push('cosmos'); holdings.push(...list); },
      () => { failed.push('cosmos'); },
    ));
  }
  await Promise.all(jobs);

  const tokens = sortTokens(holdings.flatMap((h) => classify(ctx, h) ?? []))
    .slice(0, Math.max(0, Math.floor(opts.maxTokens ?? 100)));
  const order = (k: string) => NETWORK_ORDER.indexOf(k);
  return { tokens, read: read.sort((a, b) => order(a) - order(b)), failed: failed.sort((a, b) => order(a) - order(b)) };
}

/** A fresh read laid over the last one: networks read this time are
 *  replaced, the others (a source that couldn't be reached) keep what was
 *  known. A token read this time only from Routescan — Blockscout couldn't
 *  be reached — keeps the price and flag Blockscout gave it before, so it
 *  doesn't flip to less known for a read. */
export function mergeDiscoveredTokens(prev: DiscoveredToken[], next: DiscoveryResult): DiscoveredToken[] {
  const read = new Set(next.read);
  const before = new Map(prev.map((t) => [t.key, t]));
  const out = new Map<string, DiscoveredToken>();
  for (const t of prev) if (!read.has(t.network)) out.set(t.key, t);
  for (const t of next.tokens) {
    const p = before.get(t.key);
    out.set(t.key, p && t.source === 'routescan' && !t.priced && p.priced
      ? { ...t, priced: true, priceUsd: p.priceUsd, reputation: p.reputation ?? t.reputation, logo: t.logo ?? p.logo, wellKnown: true }
      : t);
  }
  return sortTokens([...out.values()]);
}
