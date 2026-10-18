/**
 * HD account discovery.
 *
 * The wallet is multi-account: each "account" is an HD index under
 * m/44'/60'/0'/0/{idx}. The Dashboard only ever queries the *active* account,
 * and a fresh/imported wallet starts at accountCount = 1 (index 0 only). So a
 * deposit made to a non-active index — or any account on a wallet imported on a
 * new device — is BOTH invisible (never queried) AND unreachable (not in the
 * switcher). That's the "deposit not showing" bug.
 *
 * `discoverFundedAccountCount` scans the first MAX_ACCOUNTS indices and reports
 * how many accounts should be exposed so every funded account is reachable in
 * the switcher. It only ever GROWS the count — it never hides an account the
 * user already has.
 */
import { Mnemonic, HDNodeWallet, Wallet } from 'ethers';
import { getKametProvider } from './rpc';
import { getEvmProvider } from './evm-chains';
import { MAX_ACCOUNTS } from './vault';

/** EVM (0x, EIP-55 checksummed) address for a given HD account index. */
export function deriveEvmAddressAt(seed: string[], idx: number): string {
  const m = Mnemonic.fromPhrase(seed.join(' '));
  return HDNodeWallet.fromMnemonic(m, `m/44'/60'/0'/0/${idx}`).address;
}

/** The accounts' parent node, m/44'/60'/0'/0 — child i is account i. The
 *  BIP39 seed (2048 PBKDF2 rounds) is computed once here rather than once
 *  per account, which matters now that opening another wallet re-derives. */
function accountParent(seed: string[]): HDNodeWallet {
  return HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(seed.join(' ')), "m/44'/60'/0'/0");
}

/** Derive every account address from 0..count-1 (for the switcher / labels). */
export function deriveAccountAddresses(seed: string[], count: number): string[] {
  if (!seed || seed.length === 0) return [];
  let parent: HDNodeWallet;
  try { parent = accountParent(seed); } catch { return Array.from({ length: count }, () => ''); }
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    try { out.push(parent.deriveChild(i).address); } catch { out.push(''); }
  }
  return out;
}

/** Account addresses (0x) of one wallet's secret: a private key's one
 *  account (at 0), or a recovery phrase's accounts at `indices`. Public data
 *  — what the wallet list caches in thanos.wallet_meta. Underivable entries
 *  are left out. */
export function deriveWalletAddresses(secret: string, indices: number[]): Record<number, string> {
  const out: Record<number, string> = {};
  const s = secret.trim();
  try {
    if (/^0x[0-9a-fA-F]{64}$/.test(s)) {
      out[0] = new Wallet(s).address;
      return out;
    }
    const parent = accountParent(s.split(/\s+/));
    for (const i of indices) out[i] = parent.deriveChild(i).address;
  } catch { /* leave them missing — the row keeps its placeholder */ }
  return out;
}

/**
 * Scan HD indices 0..MAX_ACCOUNTS-1 for any account holding a native balance on
 * Lithosphere Mainnet OR Kamet, so funded accounts become reachable in the
 * switcher.
 * Returns the account count to persist: (highest funded index) + 1, clamped to
 * [1, MAX_ACCOUNTS]. Best-effort: an RPC failure for an index counts as "not
 * funded" (so discovery can only ever grow the count, never shrink it).
 */
export async function discoverFundedAccountCount(seed: string[]): Promise<number> {
  if (!seed || seed.length === 0) return 1;
  const addrs = deriveAccountAddresses(seed, MAX_ACCOUNTS);
  const results = await Promise.allSettled(
    Array.from({ length: MAX_ACCOUNTS }, (_, i) => i).map(async (i) => {
      const addr = addrs[i];
      if (!addr) throw new Error('underivable');
      const [main, kam] = await Promise.allSettled([
        getEvmProvider(9005).getBalance(addr),
        getKametProvider().getBalance(addr),
      ]);
      const val = (r: PromiseSettledResult<bigint>) => (r.status === 'fulfilled' ? r.value : 0n);
      return { i, funded: val(main) > 0n || val(kam) > 0n };
    }),
  );
  let highest = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.funded && r.value.i > highest) highest = r.value.i;
  }
  return Math.min(MAX_ACCOUNTS, highest + 1);
}
