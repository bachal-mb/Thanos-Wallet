/**
 * Lithosphere dual-address helpers for the web wallet.
 *
 * Wraps the sdk-core utilities and adds a small React hook
 * (`useWalletAddresses`) that returns the user's wallet in both formats
 * given a derived EVM address.
 */
import { useMemo } from 'react';
import { getAddress } from 'ethers';
import {
  isEvmAddress, isLithoAddress, detectAddressFormat,
  evmToLitho, lithoToEvm,
  normaliseLithoAddress, resolveToEvm,
  truncateLithoAddress, formatAddressForChain,
  preferredAddressFormat, validateAddressForChain,
  DUAL_ADDRESS_CHAIN_IDS, LITHO_BECH32_PREFIX,
} from '@thanos/sdk-core/src/utils/litho-address';

export {
  isEvmAddress, isLithoAddress, detectAddressFormat,
  evmToLitho, lithoToEvm,
  normaliseLithoAddress, resolveToEvm,
  truncateLithoAddress, formatAddressForChain,
  preferredAddressFormat, validateAddressForChain,
  DUAL_ADDRESS_CHAIN_IDS, LITHO_BECH32_PREFIX,
};

/** Lithosphere Mainnet. */
export const LITHO_MAINNET_CHAIN_ID = 9005;

/** A Lithosphere account in its standard form, litho1… (client 2026-10-15:
 *  "make litho1 format the preferred standard"). A 0x address becomes the
 *  same account's litho1…; anything else (litho1…, a name, partial input)
 *  comes back unchanged. Display / fill only — what's stored and sent
 *  doesn't change. */
export function toLithoForm(address: string): string {
  const a = address.trim();
  if (!isEvmAddress(a)) return address;
  try { return evmToLitho(a); } catch { return address; }
}

/** An address as the wallet shows it on its network. Lithosphere Mainnet
 *  goes by litho1…, as LithoScan shows it (client 2026-10-15: "make litho1
 *  first class"); every other network keeps the form it was given. Display
 *  and fill only — what's signed and sent stays 0x. */
export function displayAddress(address: string, chainId: number | null | undefined): string {
  return chainId === LITHO_MAINNET_CHAIN_ID ? toLithoForm(address) : address;
}

/** The Send recipient carried over to another network. Lithosphere Mainnet
 *  goes by litho1…, every other EVM network takes only 0x… — so the same
 *  account switches form with the network (`chainId` null = not an EVM
 *  network: left as typed). Names and partial input are left alone too. */
export function recipientForChain(input: string, chainId: number | null | undefined): string {
  if (chainId == null) return input;
  if (chainId === LITHO_MAINNET_CHAIN_ID) return toLithoForm(input);
  const a = input.trim();
  if (!isLithoAddress(a)) return input;
  try { return getAddress(lithoToEvm(a)); } catch { return input; }
}

/** Compact address for lists and hints. "litho1" is a fixed prefix, so it
 *  keeps as many of the account's own characters as the 0x form does. */
export function shortAddress(address: string): string {
  if (address.startsWith('litho1')) return address.length > 20 ? `${address.slice(0, 12)}…${address.slice(-6)}` : address;
  return address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

export interface DualAddress {
  /** EIP-55 checksummed `0x…`. Always present once a wallet is unlocked. */
  evm:   string;
  /** Lithosphere bech32 `litho1…`. */
  litho: string;
  /** Convenience: truncated litho1 for compact UI chips. */
  shortLitho: string;
  /** Convenience: truncated 0x for compact UI chips. */
  shortEvm: string;
}

/**
 * Given an EVM hex address (the canonical form derived by ethers from the
 * mnemonic at m/44'/60'/0'/0/0), return both representations + a couple of
 * pre-truncated forms for direct rendering.
 */
export function dualFromEvm(evm: string): DualAddress | null {
  if (!isEvmAddress(evm)) return null;
  const { evm: checksummed, litho } = normaliseLithoAddress(evm);
  return {
    evm:        checksummed,
    litho,
    shortLitho: truncateLithoAddress(litho, 8, 6),
    shortEvm:   truncateLithoAddress(checksummed, 6, 4),
  };
}

export function useWalletAddresses(evmAddress: string | null | undefined): DualAddress | null {
  return useMemo(() => {
    if (!evmAddress) return null;
    return dualFromEvm(evmAddress);
  }, [evmAddress]);
}
