import { describe, it, expect } from 'vitest';
import { getAddress } from 'ethers';
import {
  evmToLitho, displayAddress, toLithoForm, recipientForChain, shortAddress, LITHO_MAINNET_CHAIN_ID,
} from './address';

const EVM   = getAddress('0x742d35cc6634c0532925a3b844bc454e4438f44e');
const LITHO = evmToLitho(EVM);

describe('toLithoForm / displayAddress', () => {
  it('shows a 0x account as its litho1 form; leaves anything else as given', () => {
    expect(LITHO.startsWith('litho1')).toBe(true);
    expect(toLithoForm(EVM)).toBe(LITHO);
    expect(toLithoForm(EVM.toLowerCase())).toBe(LITHO);
    expect(toLithoForm(LITHO)).toBe(LITHO);
    expect(toLithoForm('alice.litho')).toBe('alice.litho');
    expect(toLithoForm('0x742d')).toBe('0x742d');
  });

  it('converts on Lithosphere Mainnet only', () => {
    expect(displayAddress(EVM, LITHO_MAINNET_CHAIN_ID)).toBe(LITHO);
    expect(displayAddress(EVM, 1)).toBe(EVM);
    expect(displayAddress(EVM, null)).toBe(EVM);
  });
});

describe('recipientForChain', () => {
  it('switching to Lithosphere turns a 0x recipient into litho1', () => {
    expect(recipientForChain(EVM, LITHO_MAINNET_CHAIN_ID)).toBe(LITHO);
    expect(recipientForChain(`  ${EVM} `, LITHO_MAINNET_CHAIN_ID)).toBe(LITHO);
    expect(recipientForChain(LITHO, LITHO_MAINNET_CHAIN_ID)).toBe(LITHO);
  });

  it('switching to another EVM network turns a litho1 recipient into its checksummed 0x', () => {
    expect(recipientForChain(LITHO, 1)).toBe(EVM);
    expect(recipientForChain(LITHO, 8453)).toBe(EVM);
    expect(recipientForChain(EVM, 8453)).toBe(EVM);
  });

  it('leaves names, partial input and non-EVM networks as typed', () => {
    expect(recipientForChain('alice.litho', LITHO_MAINNET_CHAIN_ID)).toBe('alice.litho');
    expect(recipientForChain('litho1abc', 1)).toBe('litho1abc');
    expect(recipientForChain(LITHO, null)).toBe(LITHO);
    expect(recipientForChain(EVM, undefined)).toBe(EVM);
    expect(recipientForChain('', 1)).toBe('');
  });
});

describe('shortAddress', () => {
  it('keeps six account characters either side of the prefix', () => {
    expect(shortAddress(LITHO)).toBe(`${LITHO.slice(0, 12)}…${LITHO.slice(-6)}`);
    expect(shortAddress(EVM)).toBe(`${EVM.slice(0, 8)}…${EVM.slice(-6)}`);
    expect(shortAddress('litho1short')).toBe('litho1short');
  });
});
