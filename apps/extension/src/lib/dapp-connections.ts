/**
 * Sites connected to the wallet (window.ethereum), keyed by origin.
 *
 * A site sees one account: the one eth_accounts returns, the one its
 * eth_sendTransaction `from` must match, and the one the popup signs with.
 * The popup always signs with the ACTIVE account, so the connections follow
 * it: switching accounts moves every connected site to the new account, and
 * the accountsChanged event that follows names the same account eth_accounts
 * does. Without this a site is told about the new account while eth_accounts
 * and the `from` check stay on the old one (dApps then fail with "invalid
 * account", or sign with a key other than the one they asked for).
 */
export interface Connection {
  address:     string;
  connectedAt: number;
}
export type ConnectionMap = Record<string, Connection>;

/** The connections moved to `address`, or null when every one is on it already. */
export function followActiveAccount(conns: ConnectionMap, address: string): ConnectionMap | null {
  const target = address.toLowerCase();
  const stale = Object.keys(conns).filter((origin) => conns[origin].address.toLowerCase() !== target);
  if (stale.length === 0) return null;
  const next: ConnectionMap = { ...conns };
  for (const origin of stale) next[origin] = { ...conns[origin], address };
  return next;
}
