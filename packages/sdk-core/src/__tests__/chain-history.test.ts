import { describe, expect, it } from 'vitest';
import * as core from '../history/chain-history';

// The mobile app carries a detached twin (EAS can't resolve this workspace
// package); run the same suite against it. Loaded at runtime so it stays
// outside this package's tsc rootDir.
const MOBILE_TWIN = '../../../../apps/mobile/lib/chain-history';
const mobile = (await import(/* @vite-ignore */ MOBILE_TWIN)) as typeof import('../history/chain-history');

const ME = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const BTC_ME = 'bc1qme0000000000000000000000000000000000';
const SOL_ME = 'SoLMe111111111111111111111111111111111111';
const ATOM_ME = 'cosmos1me00000000000000000000000000000000000';

type Route = [match: string, body: unknown];

/** fetch stand-in: the first route whose substring is in the URL (or POST
 *  body) answers; a body of `Error` makes that request fail. */
function fakeFetch(routes: Route[], seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${url} ${typeof init?.body === 'string' ? init.body : ''}`;
    seen.push(key);
    const hit = routes.find(([m]) => key.includes(m));
    if (!hit || hit[1] instanceof Error) return { ok: false, status: 503, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => hit[1] } as Response;
  }) as typeof fetch;
}

const EMPTY_EXPLORERS: Route[] = [
  ['blockscout.com', { items: [] }],
  ['explorer.optimism.io', { items: [] }],
  ['routescan.io', { status: '0', message: 'No transactions found', result: [] }],
];

describe.each([['sdk-core', core], ['mobile twin', mobile]])('%s fetchChainHistory', (_name, m) => {
  it('formats base units exactly', () => {
    expect(m.formatBaseUnits(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(m.formatBaseUnits(5n, 8)).toBe('0.00000005');
    expect(m.formatBaseUnits(-2_000_000n, 6)).toBe('-2');
  });

  it('reads LITHO in and out from LithoScan, page by page, skipping contract calls', async () => {
    const seen: string[] = [];
    const page = (offset: number, hasMore: boolean, items: unknown[]) => [`txs?limit=100&offset=${offset}`, { items, hasMore }] as Route;
    const { rows, failed } = await m.fetchChainHistory({ evm: ME }, {
      sources: 'lithosphere', lithoPages: 3,
      fetchImpl: fakeFetch([
        page(0, true, [
          { evmHash: '0xa1', evmFromAddr: OTHER, evmToAddr: ME, value: '2000000000000000000', inputData: '0x', timestamp: '2026-10-14T10:00:00Z', success: true },
          { evmHash: '0xa2', evmFromAddr: ME, evmToAddr: OTHER, value: '1', inputData: '0xa9059cbb', timestamp: '2026-10-14T09:00:00Z' },
        ]),
        page(100, false, [
          { evmHash: '0xa3', evmFromAddr: ME, evmToAddr: OTHER, value: '500000000000000000', inputData: '0x', timestamp: '2026-10-13T10:00:00Z', success: false },
        ]),
      ], seen),
    });
    expect(failed).toEqual([]);
    expect(rows.map((r) => [r.hash, r.direction, r.amount, r.status, r.sym, r.chainId])).toEqual([
      ['0xa1', 'in', '2', 'confirmed', 'LITHO', 9005],
      ['0xa3', 'out', '0.5', 'failed', 'LITHO', 9005],
    ]);
    expect(seen.filter((u) => u.includes('lithoscan')).length).toBe(2); // stopped when hasMore was false
    expect(seen.some((u) => u.includes('blockscout'))).toBe(false);     // 'lithosphere' reads nothing else
  });

  it('gives Lithosphere rows their native hash and litho1 counterparty, as LithoScan shows them', async () => {
    const NATIVE = '8A629CB5DE9BC3A5FDF9E4F93A3613E7A60F29A49B5DFA4C90208BECEB872632';
    const { rows } = await m.fetchChainHistory({ evm: ME }, {
      sources: 'lithosphere',
      fetchImpl: fakeFetch([['txs?limit=100&offset=0', { hasMore: false, items: [
        { hash: NATIVE, evmHash: '0xa1', fromAddr: 'litho1them', toAddr: 'litho1me', evmFromAddr: OTHER, evmToAddr: ME, value: '1', inputData: '0x', timestamp: '2026-10-15T11:14:00Z' },
        { evmHash: '0xa2', evmFromAddr: ME, evmToAddr: OTHER, value: '1', inputData: '0x', timestamp: '2026-10-15T10:00:00Z' },
      ] }]]),
    });
    expect(rows[0]).toMatchObject({ hash: '0xa1', nativeHash: NATIVE, counterparty: 'litho1them' });
    expect(rows[1].nativeHash).toBeUndefined();          // older rows without one
    expect(rows[1].counterparty).toBe(OTHER);             // falls back to 0x
  });

  it('looks up a native hash by its 0x hash and builds LithoScan links', async () => {
    const evm = '0x178d40b689a78647e0e4f95609cbc3130da03d1d5ba0377a73794c3492897d5d';
    const seen: string[] = [];
    const fetchImpl = fakeFetch([['/api/txs/' + evm, { hash: '8a629cb5de9bc3a5fdf9e4f93a3613e7a60f29a49b5dfa4c90208beceb872632', evmHash: evm }]], seen);
    expect(await m.fetchLithoNativeHash(evm, { fetchImpl })).toBe('8A629CB5DE9BC3A5FDF9E4F93A3613E7A60F29A49B5DFA4C90208BECEB872632');
    expect(await m.fetchLithoNativeHash('0x1234', { fetchImpl })).toBeNull();          // not a tx hash: no request
    expect(await m.fetchLithoNativeHash('0x' + 'b'.repeat(64), { fetchImpl })).toBeNull(); // not indexed
    expect(seen.length).toBe(2);
    expect(m.lithoscanTxUrl('ABC')).toBe('https://lithoscan.ai/txs/ABC');
    expect(m.lithoscanAddressUrl('litho1x')).toBe('https://lithoscan.ai/address/litho1x');
  });

  it('keeps known and priced tokens from Blockscout and drops spam and fakes', async () => {
    const tok = (address: string, symbol: string, extra: Record<string, unknown> = {}) => ({ address_hash: address, symbol, decimals: '6', ...extra });
    const transfer = (hash: string, token: unknown, from = OTHER, to = ME, value = '2500000') =>
      ({ transaction_hash: hash, from: { hash: from }, to: { hash: to }, token, total: { value, decimals: '6' }, timestamp: '2026-10-10T00:00:00Z', log_index: 1 });
    const { rows } = await m.fetchChainHistory({ evm: ME }, {
      fetchImpl: fakeFetch([
        ['lithoscan', { items: [], hasMore: false }],
        ['eth.blockscout.com/api/v2/addresses/' + ME + '/transactions', { items: [
          { hash: '0xe1', from: { hash: OTHER }, to: { hash: ME }, value: '1000000000000000000', status: 'ok', result: 'success', timestamp: '2026-10-12T00:00:00Z' },
          { hash: '0xe2', from: { hash: ME }, to: { hash: OTHER }, value: '1000', status: 'error', result: 'Reverted', timestamp: '2026-10-11T00:00:00Z' },
          { hash: '0xe3', from: { hash: OTHER }, to: { hash: ME }, value: '7', status: 'error', result: 'Reverted', timestamp: '2026-10-11T00:00:00Z' },
          { hash: '0xe4', from: { hash: ME }, to: { hash: OTHER }, value: '0', status: 'ok', result: 'success', timestamp: '2026-10-11T00:00:00Z' },
        ] }],
        ['eth.blockscout.com/api/v2/addresses/' + ME + '/token-transfers', { items: [
          transfer('0xt1', tok(USDT_ETH, 'USDT')),                                              // the real USDT
          transfer('0xt2', tok('0xfeed', 'PEPE', { exchange_rate: '0.00001', reputation: 'ok' })), // priced
          transfer('0xt3', tok('0xbad1', 'USDT', { exchange_rate: '1' })),                       // fake USDT
          transfer('0xt4', tok('0xbad2', 'ZIK')),                                                // unpriced airdrop
          transfer('0xt5', tok('0xbad3', 'GIFT', { exchange_rate: '1', reputation: 'scam' })),   // flagged
          transfer('0xt6', tok('0xbad4', 'visit-x.com', { exchange_rate: '1' })),                // URL lure
          transfer('0xt7', tok(USDT_ETH, 'USDT'), ME, OTHER, '0'),                                // zero-value poisoning
        ] }],
        ...EMPTY_EXPLORERS,
      ]),
    });
    expect(rows.map((r) => `${r.hash}:${r.sym}:${r.direction}:${r.status}`).sort()).toEqual([
      '0xe1:ETH:in:confirmed',
      '0xe2:ETH:out:failed',
      '0xt1:USDT:in:confirmed',
      '0xt2:PEPE:in:confirmed',
    ]);
    expect(rows.find((r) => r.hash === '0xt1')?.amount).toBe('2.5');
  });

  it('accepts tokens the user added', async () => {
    const { rows } = await m.fetchChainHistory({ evm: ME }, {
      knownTokens: [{ chainId: 1, address: '0xAbCd' }],
      fetchImpl: fakeFetch([
        ['lithoscan', { items: [], hasMore: false }],
        ['eth.blockscout.com/api/v2/addresses/' + ME + '/token-transfers', { items: [
          { transaction_hash: '0xc1', from: { hash: OTHER }, to: { hash: ME }, token: { address_hash: '0xabcd', symbol: 'MINE', decimals: '0' }, total: { value: '3', decimals: '0' }, timestamp: '2026-10-10T00:00:00Z' },
        ] }],
        ...EMPTY_EXPLORERS,
      ]),
    });
    expect(rows.map((r) => `${r.sym}:${r.amount}`)).toEqual(['MINE:3']);
  });

  it('reads BNB Chain only with an Etherscan key, and only known tokens there', async () => {
    const seen: string[] = [];
    const bsc: Route[] = [
      ['chainid=56&module=account&action=txlist', { status: '1', result: [
        { hash: '0xb1', from: ME, to: OTHER, value: '20000000000000000', timeStamp: '1792000000', isError: '0', txreceipt_status: '1', blockNumber: '5' },
      ] }],
      ['chainid=56&module=account&action=tokentx', { status: '1', result: [
        { hash: '0xb2', from: OTHER, to: ME, value: '1000000000000000000', contractAddress: '0x55d398326f99059ff775485246999027b3197955', tokenSymbol: 'USDT', tokenDecimal: '18', timeStamp: '1792000001' },
        { hash: '0xb3', from: OTHER, to: ME, value: '9', contractAddress: '0xspam', tokenSymbol: 'FREE', tokenDecimal: '0', timeStamp: '1792000002' },
      ] }],
      ['chainid=59144', { status: '0', message: 'No transactions found', result: [] }],
    ];
    const routes: Route[] = [['lithoscan', { items: [], hasMore: false }], ...bsc, ...EMPTY_EXPLORERS];
    const without = await m.fetchChainHistory({ evm: ME }, { fetchImpl: fakeFetch(routes, seen) });
    expect(without.rows).toEqual([]);
    expect(seen.some((u) => u.includes('etherscan.io'))).toBe(false);

    const withKey = await m.fetchChainHistory({ evm: ME }, { etherscanKey: 'K', fetchImpl: fakeFetch(routes, seen) });
    expect(withKey.rows.map((r) => `${r.hash}:${r.sym}:${r.direction}:${r.amount}`)).toEqual(['0xb2:USDT:in:1', '0xb1:BNB:out:0.02']);
    expect(seen.some((u) => u.includes('apikey=K'))).toBe(true);
    expect(m.historyEvmChainIds()).not.toContain(56);
    expect(m.historyEvmChainIds('K')).toEqual(expect.arrayContaining([9005, 1, 56, 59144, 43114]));
  });

  it('works out Bitcoin sends without change, receives, and pending', async () => {
    const { rows } = await m.fetchChainHistory({ bitcoin: BTC_ME }, {
      fetchImpl: fakeFetch([[`mempool.space/api/address/${BTC_ME}/txs`, [
        { txid: 'b-out', status: { confirmed: true, block_time: 1792000000 },
          vin: [{ prevout: { scriptpubkey_address: BTC_ME, value: 100_000 } }],
          vout: [{ scriptpubkey_address: 'bc1qthem', value: 30_000 }, { scriptpubkey_address: BTC_ME, value: 69_000 }] },
        { txid: 'b-in', status: { confirmed: false },
          vin: [{ prevout: { scriptpubkey_address: 'bc1qthem', value: 50_000 } }],
          vout: [{ scriptpubkey_address: BTC_ME, value: 40_000 }] },
        { txid: 'b-self', status: { confirmed: true, block_time: 1791000000 },
          vin: [{ prevout: { scriptpubkey_address: BTC_ME, value: 10_000 } }],
          vout: [{ scriptpubkey_address: BTC_ME, value: 9_000 }] },
      ]]]),
    });
    const byHash = Object.fromEntries(rows.map((r) => [r.hash, r]));
    expect(Object.keys(byHash).sort()).toEqual(['b-in', 'b-out']);
    expect(byHash['b-out']).toMatchObject({ direction: 'out', amount: '0.0003', status: 'confirmed', counterparty: 'bc1qthem' });
    expect(byHash['b-in']).toMatchObject({ direction: 'in', amount: '0.0004', status: 'pending' });
  });

  it('reads Solana transfers without the fee and skips signatures already saved', async () => {
    const seen: string[] = [];
    const tx = (pre: number[], post: number[], fee: number, tokens?: { pre: unknown[]; post: unknown[] }) => ({
      jsonrpc: '2.0', id: 1,
      result: {
        blockTime: 1792000000,
        transaction: { message: { accountKeys: [{ pubkey: SOL_ME }, { pubkey: 'Them' }] } },
        meta: { err: null, fee, preBalances: pre, postBalances: post, preTokenBalances: tokens?.pre ?? [], postTokenBalances: tokens?.post ?? [] },
      },
    });
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const { rows } = await m.fetchChainHistory({ solana: SOL_ME }, {
      knownHashes: ['sig-old'],
      fetchImpl: fakeFetch([
        ['getSignaturesForAddress', { jsonrpc: '2.0', id: 1, result: [
          { signature: 'sig-send', err: null }, { signature: 'sig-usdc', err: null },
          { signature: 'sig-old', err: null }, { signature: 'sig-failed', err: { InstructionError: [0, 'x'] } },
        ] }],
        ['"sig-send"', tx([2_000_000_000, 0], [1_499_995_000, 500_000_000], 5000)],
        ['"sig-usdc"', tx([1_000_000_000, 0], [999_995_000, 0], 5000, {
          pre: [{ owner: SOL_ME, mint: usdc, uiTokenAmount: { amount: '0', decimals: 6 } }],
          post: [{ owner: SOL_ME, mint: usdc, uiTokenAmount: { amount: '12500000', decimals: 6 } }],
        })],
      ], seen),
    });
    expect(rows.map((r) => `${r.hash}:${r.sym}:${r.direction}:${r.amount}`).sort()).toEqual(['sig-send:SOL:out:0.5', 'sig-usdc:USDC:in:12.5']);
    expect(seen.some((u) => u.includes('"sig-old"') || u.includes('"sig-failed"'))).toBe(false);
  });

  it('reads Cosmos Hub sends and receives in ATOM', async () => {
    const msg = (from: string, to: string, uatom: string) => ({ '@type': '/cosmos.bank.v1beta1.MsgSend', from_address: from, to_address: to, amount: [{ denom: 'uatom', amount: uatom }] });
    const { rows } = await m.fetchChainHistory({ cosmos: ATOM_ME }, {
      fetchImpl: fakeFetch([
        ['message.sender', { tx_responses: [{ txhash: 'C1', code: 0, height: '7', timestamp: '2026-10-09T00:00:00Z', tx: { body: { messages: [msg(ATOM_ME, 'cosmos1them', '1500000')] } } }] }],
        ['transfer.recipient', { tx_responses: [
          { txhash: 'C2', code: 0, timestamp: '2026-10-10T00:00:00Z', tx: { body: { messages: [msg('cosmos1them', ATOM_ME, '250000'), { '@type': '/cosmos.staking.v1beta1.MsgDelegate' }] } } },
          { txhash: 'C3', code: 5, timestamp: '2026-10-08T00:00:00Z', tx: { body: { messages: [msg('cosmos1them', ATOM_ME, '9')] } } },
        ] }],
      ]),
    });
    expect(rows.map((r) => `${r.hash}:${r.direction}:${r.amount}:${r.status}`)).toEqual(['C2:in:0.25:confirmed', 'C1:out:1.5:confirmed']);
  });

  it('lists a source that fails and still returns the others', async () => {
    const { rows, failed } = await m.fetchChainHistory({ evm: ME, bitcoin: BTC_ME }, {
      fetchImpl: fakeFetch([
        ['lithoscan', { items: [{ evmHash: '0xl1', evmFromAddr: OTHER, evmToAddr: ME, value: '1', inputData: '0x', timestamp: '2026-10-14T00:00:00Z' }], hasMore: false }],
        ['mempool.space', new Error('down')],
        ...EMPTY_EXPLORERS,
      ]),
    });
    expect(failed).toEqual(['bitcoin']);
    expect(rows.map((r) => r.hash)).toEqual(['0xl1']);
  });
});
