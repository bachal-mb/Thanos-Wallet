/**
 * Connected sites follow the active account — lib/dapp-connections.ts
 * (run: pnpm --filter @thanos/extension test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followActiveAccount, type ConnectionMap } from '../src/lib/dapp-connections';

const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

test('switching accounts moves every connected site to the new account', () => {
  const conns: ConnectionMap = {
    'https://lithovault.ai': { address: A, connectedAt: 1 },
    'https://app.example':   { address: A, connectedAt: 2 },
  };
  const moved = followActiveAccount(conns, B);
  assert.deepEqual(moved, {
    'https://lithovault.ai': { address: B, connectedAt: 1 },
    'https://app.example':   { address: B, connectedAt: 2 },
  });
  // The stored map is not changed in place.
  assert.equal(conns['https://lithovault.ai'].address, A);
});

test('nothing to store when every site is on the active account already (any letter case)', () => {
  assert.equal(followActiveAccount({ 'https://lithovault.ai': { address: A.toLowerCase(), connectedAt: 1 } }, A), null);
  assert.equal(followActiveAccount({}, A), null);
});

test('only the sites on another account change', () => {
  const moved = followActiveAccount({
    'https://lithovault.ai': { address: A, connectedAt: 1 },
    'https://app.example':   { address: B, connectedAt: 2 },
  }, B);
  assert.deepEqual(moved?.['https://lithovault.ai'], { address: B, connectedAt: 1 });
  assert.deepEqual(moved?.['https://app.example'], { address: B, connectedAt: 2 });
});
