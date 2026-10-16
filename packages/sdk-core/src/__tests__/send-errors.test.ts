import { describe, expect, it } from 'vitest';
import * as core from '../utils/send-errors';

// The mobile app carries a detached twin (EAS can't resolve this workspace
// package); run the same suite against it. Loaded at runtime so it stays
// outside this package's tsc rootDir.
const MOBILE_TWIN = '../../../../apps/mobile/lib/send-errors';
const mobile = (await import(/* @vite-ignore */ MOBILE_TWIN)) as typeof import('../utils/send-errors');

/** The error a phone showed on 2026-10-16, re-sending a Lithosphere payment
 *  the website had already broadcast. */
const MEMPOOL = Object.assign(new Error(
  'could not coalesce error (error={ "code": -32000, "message": ": tx already in mempool" }, payload={ "id": 7, "jsonrpc": "2.0", '
  + '"method": "eth_sendRawTransaction", "params": [ "0x02f86c82232d09800e825208947c5fa20e00d416879acffb1053cc6825dc49eb1f88ec0500649f1180" ] }, '
  + 'code=UNKNOWN_ERROR, version=6.17.0)'), { code: 'UNKNOWN_ERROR', error: { code: -32000, message: ': tx already in mempool' } });

describe.each([['sdk-core', core], ['mobile twin', mobile]])('%s humanSendError', (_name, m) => {
  it('explains a transaction that is already waiting, without the raw payload', () => {
    const msg = m.humanSendError(MEMPOOL);
    expect(msg).toMatch(/already on its way/);
    expect(msg).not.toMatch(/payload|0x02f8|coalesce/);
  });

  it('maps the common node and ethers failures', () => {
    expect(m.humanSendError(Object.assign(new Error('x'), { code: 'INSUFFICIENT_FUNDS' }))).toMatch(/Not enough balance/);
    expect(m.humanSendError(new Error('nonce too low: next nonce 22, tx nonce 9'))).toMatch(/refresh and try again/);
    expect(m.humanSendError(Object.assign(new Error('x'), { code: 'REPLACEMENT_UNDERPRICED' }))).toMatch(/still waiting/);
    expect(m.humanSendError(Object.assign(new Error('x'), { code: 'NETWORK_ERROR' }))).toMatch(/Couldn't reach the network/);
    expect(m.humanSendError(Object.assign(new Error('x'), { code: 'ACTION_REJECTED' }))).toBe('Transaction cancelled.');
    expect(m.humanSendError(new Error('execution reverted'))).toMatch(/would fail on-chain/);
  });

  it("gives an unknown node reason briefly and otherwise a plain fallback", () => {
    expect(m.humanSendError({ message: 'x', error: { message: 'fee market disabled' } })).toBe("The network didn't accept this transaction: fee market disabled.");
    expect(m.humanSendError(new Error('could not coalesce error (payload={ "params": [ "0x' + 'ab'.repeat(60) + '" ] })'))).toMatch(/Nothing left your wallet/);
    expect(m.humanSendError(undefined)).toMatch(/didn't accept/);
  });
});
