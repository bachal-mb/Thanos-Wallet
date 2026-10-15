import { describe, it, expect } from 'vitest';
import type { HistoryRow } from '@thanos/sdk-core';
import { mergeHistoryRows, type PendingTx } from './tx-store';

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

  it('keeps the newest 500, newest first', () => {
    const many = Array.from({ length: 500 }, (_, i) => row({ id: `r${i}`, hash: `h${i}`, ts: 10_000 + i }));
    const { list } = mergeHistoryRows([], many);
    expect(list).toHaveLength(500);
    expect(list[0].id).toBe('r499');
    // Older than everything kept: dropped, so nothing changed.
    expect(mergeHistoryRows(list, [row({ id: 'old', hash: 'old', ts: 1 })]).changed).toBe(false);
  });
});
