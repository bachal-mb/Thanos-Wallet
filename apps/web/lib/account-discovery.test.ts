/**
 * Account address derivation — the switcher, the wallet list's address
 * cache and account discovery all derive through these helpers.
 */
import { describe, expect, it } from 'vitest';
import { deriveAccountAddresses, deriveEvmAddressAt, deriveWalletAddresses } from './account-discovery';

// The well-known Hardhat/Anvil test phrase and its first accounts.
const PHRASE = 'test test test test test test test test test test test junk';
const ACCOUNTS = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
];
const KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('account derivation', () => {
  it('derives each account once from the phrase — the same addresses as one at a time', () => {
    expect(deriveAccountAddresses(PHRASE.split(' '), 3)).toEqual(ACCOUNTS);
    expect(ACCOUNTS.map((_, i) => deriveEvmAddressAt(PHRASE.split(' '), i))).toEqual(ACCOUNTS);
    expect(deriveAccountAddresses([], 3)).toEqual([]);
    expect(deriveAccountAddresses(['not', 'a', 'phrase'], 2)).toEqual(['', '']);
  });

  it('derives a wallet’s listed accounts from its secret (phrase or key)', () => {
    expect(deriveWalletAddresses(PHRASE, [0, 2])).toEqual({ 0: ACCOUNTS[0], 2: ACCOUNTS[2] });
    expect(deriveWalletAddresses(KEY_0, [0, 1, 2])).toEqual({ 0: ACCOUNTS[0] });
    expect(deriveWalletAddresses('nonsense words', [0])).toEqual({});
  });
});
