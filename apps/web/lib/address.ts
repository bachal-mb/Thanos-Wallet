/**
 * Lithosphere dual-address helpers for the web wallet.
 *
 * Wraps the sdk-core utilities and adds a small React hook
 * (`useWalletAddresses`) that returns the user's wallet in both formats
 * given a derived EVM address.
 */
import { useMemo } from 'react';
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

/** An address as the wallet shows it on its network. Lithosphere Mainnet
 *  goes by litho1…, as LithoScan shows it (client 2026-10-15: "make litho1
 *  first class"); every other network keeps the form it was given. Display
 *  only — what's stored and sent stays 0x. */
export function displayAddress(address: string, chainId: number | null | undefined): string {
  if (chainId !== LITHO_MAINNET_CHAIN_ID || !isEvmAddress(address)) return address;
  try { return evmToLitho(address); } catch { return address; }
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
