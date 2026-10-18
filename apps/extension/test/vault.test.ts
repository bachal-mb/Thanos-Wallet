/**
 * Several wallets in one vault — lib/vault.ts (run: pnpm --filter @thanos/extension test).
 *
 * node:test under tsx, with an in-memory localStorage/sessionStorage; the
 * vault crypto is the real WebCrypto (Node's globalThis.crypto).
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class MemStorage {
  private m = new Map<string, string>();
  get length(): number { return this.m.size; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
  keys(): string[] { return [...this.m.keys()]; }
}
const local = new MemStorage();
const session = new MemStorage();
for (const [name, value] of [['localStorage', local], ['sessionStorage', session], ['window', globalThis]] as const) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

// Imported once the storage shims are in place (the module reads them on load).
let V: typeof import('../src/lib/vault');
before(async () => { V = await import('../src/lib/vault'); });

const PHRASE_A = 'test test test test test test test test test test test junk';
const PHRASE_B = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PK_1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const PK_2 = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const ADDR_A0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const PW = 'correct horse battery staple';
const META = 'thanos.wallet_meta';

/** A fresh vault holding one wallet, unlocked — as onboarding leaves it. */
async function freshVault(secret: string, origin?: 'created' | 'imported'): Promise<Uint8Array> {
  local.clear(); session.clear(); V.clearVault();
  const vault = await V.createVault(secret, PW);
  V.saveVault(vault);
  V.selectWallet(V.parseWalletSet(secret));
  if (origin) V.setWalletOrigin(V.FIRST_WALLET_ID, origin);
  V.setSeedBackedUp(true);
  const opened = await V.openVault(vault, PW);
  assert.ok(opened);
  return opened.key;
}
const plaintext = async (key: Uint8Array) => V.openVaultWithKey(V.loadVault()!, key);
function added(r: Awaited<ReturnType<typeof V.addWallet>>): string {
  assert.ok('wallet' in r, 'error' in r ? r.error : '');
  return r.wallet.id;
}

beforeEach(() => { local.clear(); session.clear(); V.clearVault(); });

test('a private-key first wallet can add a created phrase wallet and another key', async () => {
  const key = await freshVault(PK_1, 'imported');

  const created = added(await V.addWallet(key, PHRASE_A, undefined, 'created'));
  assert.equal(V.getCurrentWalletId(), created, 'the new wallet opens');
  assert.equal(V.getActiveAccountIndex(), 0, 'on its first account');
  assert.equal(V.getAccountCount(), 1);
  assert.equal(V.isSeedBackedUp(), true);
  assert.equal(V.getWalletOrigin(created), 'created');
  assert.equal(V.getWalletOrigin(V.FIRST_WALLET_ID), 'imported');

  // A raw key without 0x, asked to be "created": a key is always imported.
  const second = added(await V.addWallet(key, PK_2.slice(2), 'Trading', 'created'));
  assert.equal(V.getWalletOrigin(second), 'imported');

  const list = await V.listWallets(key);
  assert.deepEqual(list?.wallets, [
    { id: V.FIRST_WALLET_ID, name: 'Wallet 1', kind: 'key' },
    { id: created, name: 'Wallet 2', kind: 'phrase' },
    { id: second, name: 'Trading', kind: 'key' },
  ]);
  assert.equal(list?.activeId, second);

  // Same plaintext format as the phone; the first wallet keeps id w0.
  const pt = JSON.parse((await plaintext(key))!);
  assert.equal(pt.format, 'thanos.wallets/1');
  assert.deepEqual(pt.wallets.map((w: { id: string; secret: string }) => [w.id, w.secret]), [
    [V.FIRST_WALLET_ID, PK_1], [created, PHRASE_A], [second, PK_2],
  ]);

  // The same wallet again is refused, however it's typed.
  const dup = await V.addWallet(key, PK_1.slice(2).toUpperCase());
  assert.ok('error' in dup && /already in Thanos/.test(dup.error));
});

test('addAccountToWallet refuses private-key wallets, adds to any phrase wallet, up to 10', async () => {
  const key = await freshVault(PHRASE_A, 'created');
  const pk = added(await V.addWallet(key, PK_1));

  const refused = await V.addAccountToWallet(key, pk);
  assert.ok('error' in refused && /private key/.test(refused.error));

  // The key wallet is open; adding to w0 opens w0 on its new account.
  const r = await V.addAccountToWallet(key, V.FIRST_WALLET_ID);
  assert.ok('idx' in r);
  assert.equal(r.idx, 1);
  assert.equal(V.getCurrentWalletId(), V.FIRST_WALLET_ID);
  assert.equal(V.getActiveAccountIndex(), 1);
  assert.deepEqual(V.readWalletAccounts(V.FIRST_WALLET_ID), { active: 1, visible: [0, 1], count: 2, names: {} });
  // The key wallet's own settings were never touched.
  assert.deepEqual(V.readWalletAccounts(pk), { active: 0, visible: [0], count: 1, names: {} });

  for (let i = 2; i < V.MAX_ACCOUNTS; i++) assert.ok('idx' in await V.addAccountToWallet(key, V.FIRST_WALLET_ID));
  const full = await V.addAccountToWallet(key, V.FIRST_WALLET_ID);
  assert.ok('error' in full && /up to 10/.test(full.error));

  const locked = await V.addAccountToWallet(new Uint8Array(32), V.FIRST_WALLET_ID);
  assert.ok('error' in locked && /locked/.test(locked.error));
  const unknown = await V.addAccountToWallet(key, 'wdeadbeef');
  assert.ok('error' in unknown);
});

test('openAccount opens another wallet on the chosen account in one step', async () => {
  const key = await freshVault(PHRASE_A);
  V.setAccountCount(3);
  const b = added(await V.addWallet(key, PHRASE_B, undefined, 'created'));
  assert.equal(V.getCurrentWalletId(), b);

  const w = await V.openAccount(key, V.FIRST_WALLET_ID, 2);
  assert.equal(w?.secret, PHRASE_A);
  assert.equal(V.getCurrentWalletId(), V.FIRST_WALLET_ID);
  assert.equal(V.getActiveAccountIndex(), 2);

  // An index the wallet doesn't list opens it on its own active account.
  await V.openAccount(key, b, 5);
  assert.equal(V.getCurrentWalletId(), b);
  assert.equal(V.getActiveAccountIndex(), 0);

  assert.equal(await V.openAccount(key, 'wnothere', 0), null);
});

test('origin and addresses are public metadata — no secret is stored outside the vault', async () => {
  const key = await freshVault(PK_1, 'imported');
  const id = added(await V.addWallet(key, PHRASE_A, 'Main', 'created'));
  V.setAccountName(0, 'Spending');
  V.setWalletAddresses(id, { 0: ADDR_A0, 1: 'not an address', 2: PK_1 } as Record<number, string>);
  assert.deepEqual(V.getWalletAddresses(id), { 0: ADDR_A0 });

  const meta = JSON.parse(local.getItem(META)!);
  assert.deepEqual(meta[id], { origin: 'created', addrs: { 0: ADDR_A0 } });
  assert.deepEqual(meta[V.FIRST_WALLET_ID], { origin: 'imported' });

  const secrets = [PK_1.slice(2), PHRASE_A, 'junk'];
  for (const k of local.keys()) {
    if (k === 'thanos.vault') continue;
    const v = local.getItem(k)!.toLowerCase();
    for (const s of secrets) assert.ok(!v.includes(s), `${k} must not hold a secret`);
  }
});

test('an existing single-wallet vault is never rewritten until a wallet is added', async () => {
  const key = await freshVault(PHRASE_A);
  const before = local.getItem('thanos.vault');
  assert.equal(V.getWalletOrigin(V.FIRST_WALLET_ID), undefined, 'origin unknown before it was recorded');

  assert.deepEqual((await V.listWallets(key))?.wallets, [{ id: V.FIRST_WALLET_ID, name: 'Wallet 1', kind: 'phrase' }]);
  await V.switchWallet(key, V.FIRST_WALLET_ID);
  await V.openAccount(key, V.FIRST_WALLET_ID, 0);
  assert.ok('idx' in await V.addAccountToWallet(key, V.FIRST_WALLET_ID));
  assert.equal(await V.renameWallet(key, V.FIRST_WALLET_ID, 'Renamed'), false);

  assert.equal(local.getItem('thanos.vault'), before);
  assert.equal(await plaintext(key), PHRASE_A, 'still the bare phrase');
  assert.equal(local.getItem('thanos.active_wallet'), null);
  // Account settings stay under the original, un-suffixed keys.
  assert.equal(local.getItem('thanos.account_count'), '2');
});

test('rename and remove: settings and metadata go with the wallet; the last one stays', async () => {
  const key = await freshVault(PHRASE_A, 'created');
  const b = added(await V.addWallet(key, PHRASE_B));
  assert.ok('idx' in await V.addAccountToWallet(key, b));
  V.setAccountName(1, 'Savings');
  V.setWalletAddresses(b, { 0: ADDR_A0 });
  assert.equal(await V.renameWallet(key, b, '  Cold storage  '), true);
  assert.equal((await V.listWallets(key))?.wallets[1].name, 'Cold storage');

  const r = await V.removeWallet(key, b);
  assert.ok('next' in r);
  assert.equal(r.next.id, V.FIRST_WALLET_ID);
  assert.equal(V.getCurrentWalletId(), V.FIRST_WALLET_ID);
  assert.deepEqual(local.keys().filter(k => k.includes(`@${b}`)), []);
  assert.equal(JSON.parse(local.getItem(META)!)[b], undefined);
  assert.equal(await plaintext(key), PHRASE_A, 'one wallet left: the bare secret again');

  const last = await V.removeWallet(key, V.FIRST_WALLET_ID);
  assert.ok('error' in last);
});

test('clearVault forgets the added wallets and all wallet metadata', async () => {
  const key = await freshVault(PK_1, 'imported');
  const id = added(await V.addWallet(key, PHRASE_A, undefined, 'created'));
  assert.ok('idx' in await V.addAccountToWallet(key, id));
  assert.ok(local.keys().some(k => k.endsWith(`@${id}`)));

  V.clearVault();
  assert.deepEqual(local.keys().filter(k => k.includes('@')), []);
  assert.equal(local.getItem(META), null);
  assert.equal(local.getItem('thanos.vault'), null);
  assert.equal(local.getItem('thanos.active_wallet'), null);
  assert.equal(V.getCurrentWalletId(), V.FIRST_WALLET_ID);
});
