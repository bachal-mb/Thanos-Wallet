import { describe, it, expect, vi, afterEach } from 'vitest';
import type { HistoryRow } from '@thanos/sdk-core';
import { loadPendingTxs, mergeHistoryRows, saveNativeHash, type PendingTx } from './tx-store';

const NATIVE = '8A629CB5DE9BC3A5FDF9E4F93A3613E7A60F29A49B5DFA4C90208BECEB872632';

const row = (over: Partial<HistoryRow>): HistoryRow => ({
  id: '0xaa:8453:native:in', hash: '0xaa', chain: 'evm', chainId: 8453, networkName: 'Base',
  sym: 'ETH', direction: 'in', amount: '0.5', counterparty: '0xfrom', ts: 1_000, status: 'confirmed',
  ...over,
});

const send = (over: Partial<PendingTx>): PendingTx => ({
  id: '0xbb', chain: 'evm', chainId: 1, symbol: 'USDC', recipient: '0xto', amount: '10',
  status: 'broadcast', broadcastAt: 2_000, updatedAt: 2_000,
  ...over,
});

describe('mergeHistoryRows', () => {
  it('saves each transfer under its own id with its network, direction and status', () => {
    const { list, changed } = mergeHistoryRows([], [
      row({}),
      row({ id: '0xcc:1:native:out', hash: '0xcc', chainId: 1, networkName: 'Ethereum', direction: 'out', ts: 3_000, status: 'failed' }),
      row({ id: 'sig1:SOL:in', hash: 'sig1', chain: 'solana', chainId: undefined, networkName: 'Solana', sym: 'SOL', ts: 2_000, status: 'pending' }),
    ]);
    expect(changed).toBe(true);
    expect(list.map(t => [t.id, t.hash, t.network, t.direction, t.status])).toEqual([
      ['0xcc:1:native:out', '0xcc', 'Ethereum', 'out', 'failed'],
      ['sig1:SOL:in', 'sig1', 'Solana', 'in', 'broadcast'],
      ['0xaa:8453:native:in', '0xaa', 'Base', 'in', 'confirmed'],
    ]);
  });

  it("settles a pending send from its hash instead of listing it twice; a swap's other leg is its own row", () => {
    const { list } = mergeHistoryRows([send({})], [
      row({ id: '0xbb:1:usdc:out:3', hash: '0xbb', chainId: 1, networkName: 'Ethereum', sym: 'USDC', direction: 'out', status: 'failed', ts: 2_100 }),
      row({ id: '0xbb:1:native:in', hash: '0xbb', chainId: 1, networkName: 'Ethereum', direction: 'in', ts: 2_100 }),
    ]);
    expect(list).toHaveLength(2);
    const sent = list.find(t => t.id === '0xbb')!;
    expect(sent.status).toBe('failed');
    expect(sent.network).toBe('Ethereum');
    expect(list.find(t => t.id === '0xbb:1:native:in')?.direction).toBe('in');
  });

  it('matches LITHO rows saved by hash before, and is a no-op on a repeat', () => {
    const legacy = send({ id: '0xdd', chainId: 9005, symbol: 'LITHO', direction: 'in', status: 'confirmed' });
    const rows = [row({ id: '0xdd:9005:native:in', hash: '0xdd', chainId: 9005, networkName: 'Lithosphere', sym: 'LITHO' })];
    const first = mergeHistoryRows([legacy], rows);
    expect(first.list).toHaveLength(1);
    expect(first.list[0].network).toBe('Lithosphere');
    expect(mergeHistoryRows(first.list, rows).changed).toBe(false);
  });

  it("keeps a Lithosphere row's native hash, and adds it to a send recorded on this device", () => {
    const litho = { chainId: 9005, networkName: 'Lithosphere', sym: 'LITHO', nativeHash: NATIVE } as const;
    const fresh = mergeHistoryRows([], [row({ id: '0xff:9005:native:in', hash: '0xff', ...litho })]);
    expect(fresh.list[0]).toMatchObject({ hash: '0xff', nativeHash: NATIVE });

    const sent = send({ id: '0xee', chainId: 9005, symbol: 'LITHO', direction: 'out', status: 'confirmed' });
    const rows = [row({ id: '0xee:9005:native:out', hash: '0xee', direction: 'out', ...litho })];
    const first = mergeHistoryRows([sent], rows);
    expect(first.changed).toBe(true);
    expect(first.list).toHaveLength(1);
    // Still keyed by its 0x hash — only the native hash is added.
    expect(first.list[0]).toMatchObject({ id: '0xee', nativeHash: NATIVE });
    expect(mergeHistoryRows(first.list, rows).changed).toBe(false);
  });

  it('keeps the newest 500, newest first', () => {
    const many = Array.from({ length: 500 }, (_, i) => row({ id: `r${i}`, hash: `h${i}`, ts: 10_000 + i }));
    const { list } = mergeHistoryRows([], many);
    expect(list).toHaveLength(500);
    expect(list[0].id).toBe('r499');
    // Older than everything kept: dropped, so nothing changed.
    expect(mergeHistoryRows(list, [row({ id: 'old', hash: 'old', ts: 1 })]).changed).toBe(false);
  });
});

describe('saveNativeHash', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('saves the native hash onto every row with that 0x hash, once', () => {
    const mem = new Map<string, string>();
    const setItem = vi.fn((k: string, v: string) => { mem.set(k, v); });
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem });
    mem.set('thanos.pending_txs', JSON.stringify([
      send({ id: '0xAB', chainId: 9005, symbol: 'LITHO' }),
      send({ id: '0xab:9005:native:in', hash: '0xab', chainId: 9005, direction: 'in' }),
      send({ id: '0xcd', chainId: 9005 }),
    ]));
    saveNativeHash('0xab', NATIVE);
    expect(loadPendingTxs().map(t => t.nativeHash)).toEqual([NATIVE, NATIVE, undefined]);
    saveNativeHash('0xab', NATIVE);
    expect(setItem).toHaveBeenCalledTimes(1);
  });
});
