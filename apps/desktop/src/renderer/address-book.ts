/**
 * Desktop address book — hybrid local-cache + cloud-sync model.
 * Same surface as apps/web/lib/address-book.ts and the extension's;
 * a contact added here syncs to all of them via /contacts.
 *
 * litho1… and 0x… are the same Lithosphere account. Either is accepted, but
 * a contact is saved and synced as 0x, exactly as before (type 'evm') — the
 * client builds users have now throw on a litho1… contact. litho1 is a
 * display form only (client 2026-10-15: "make litho1 the preferred
 * standard"); reads tolerate either, and lookups match on the account.
 */
import { getAddress } from 'ethers';
import { evmToLitho, lithoToEvm } from '@thanos/sdk-core';
import { apiClient } from './auth-client';
import type { ContactDto } from '@thanos/api-client';
import { encryptField, decryptField } from './contact-crypto';

const STORAGE_KEY = 'thanos.address_book';

export interface Contact {
  id:          string;
  name:        string;
  /** 0x… (EIP-55) — a litho1… entry is saved as its 0x — or another
   *  chain's address kept raw. */
  evm:         string;
  /** litho1… form of a 0x… / litho1… account — what the UI shows. */
  litho?:      string;
  note?:       string;
  updatedAt:   number;
  pendingSync?: boolean;
}

/** litho1… for a 0x… or litho1… address (the same account); undefined for
 *  anything else. Never throws — a bad address just has no litho1 form. */
export function contactLitho(address: string): string | undefined {
  const v = (address || '').trim();
  try {
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) return evmToLitho(v);
    if (/^litho1/i.test(v)) { lithoToEvm(v.toLowerCase()); return v.toLowerCase(); }
  } catch { /* not a valid address */ }
  return undefined;
}

/** 0x… (EIP-55) for a 0x… or litho1… address; undefined for anything else.
 *  A contact's secondary "EVM address". */
export function contactEvm(address: string): string | undefined {
  const v = (address || '').trim();
  try {
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) return getAddress(v.toLowerCase());
    if (/^litho1/i.test(v)) return lithoToEvm(v.toLowerCase());
  } catch { /* not a valid address */ }
  return undefined;
}

/** The account an address stands for: its lowercased 0x form for 0x… and
 *  litho1… (so both forms of one account match), else the address lowercased. */
function accountKey(address: string): string {
  return (contactEvm(address) ?? (address || '').trim()).toLowerCase();
}

function newId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

export function loadContacts(): Contact[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Contact[]) : [];
  } catch { return []; }
}

function saveContacts(list: Contact[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  try { window.dispatchEvent(new CustomEvent('thanos:contacts-changed')); } catch { /* no-op */ }
}

async function contactFromDto(d: ContactDto): Promise<Contact> {
  // A row another client saved as litho1… reads as its 0x account; anything
  // else that isn't 0x (a non-EVM address) is kept raw, as before.
  let evm = d.address;
  try { evm = getAddress(d.address); } catch { evm = contactEvm(d.address) ?? d.address; }
  const [name, note] = await Promise.all([decryptField(d.name), decryptField(d.notes)]);
  return {
    id:        d.id,
    name:      name ?? d.name,
    evm,
    litho:     contactLitho(evm),
    note:      note ?? undefined,
    updatedAt: new Date(d.updatedAt).getTime(),
  };
}

async function isAuthed(): Promise<boolean> {
  try { return await apiClient.isAuthenticated(); }
  catch { return false; }
}

export async function addContact(input: { name: string; address: string; note?: string }): Promise<Contact> {
  const trimmedName = input.name.trim();
  if (!trimmedName) throw new Error('Name required');

  // litho1… or 0x — one account either way, saved and synced in its 0x form
  // as before: every client build reads that, and the ones users have now
  // throw on a litho1… contact. litho1 is only how it's shown.
  let evm = input.address.trim();
  if (/^litho1/i.test(evm)) {
    const asEvm = contactEvm(evm);
    if (!asEvm) throw new Error('Not a valid litho1 address');
    evm = asEvm;
  } else {
    try { evm = getAddress(evm); } catch { /* not EVM — accept raw */ }
  }

  const all = loadContacts();
  const key = accountKey(evm);
  if (all.some(c => accountKey(c.evm) === key)) throw new Error('Address already in your contacts');

  if (await isAuthed()) {
    const [encName, encNote] = await Promise.all([
      encryptField(trimmedName),
      encryptField(input.note?.trim() || undefined),
    ]);
    const { item } = await apiClient.createContact({
      name:        encName ?? trimmedName,
      address:     evm,
      addressType: 'evm',
      notes:       encNote ?? (input.note?.trim() || undefined),
    });
    const contact = await contactFromDto(item);
    saveContacts([...all, contact]);
    return contact;
  }

  const contact: Contact = {
    id:          newId(),
    name:        trimmedName,
    evm,
    litho:       contactLitho(evm),
    note:        input.note?.trim() || undefined,
    updatedAt:   Date.now(),
    pendingSync: true,
  };
  saveContacts([...all, contact]);
  return contact;
}

export async function deleteContact(id: string): Promise<boolean> {
  const all = loadContacts();
  const existing = all.find(c => c.id === id);
  if (!existing) return false;
  if ((await isAuthed()) && !existing.pendingSync) {
    try { await apiClient.deleteContact(id); }
    catch (e) {
      const status = (e as { status?: number } | null)?.status;
      if (status !== 404) throw e;
    }
  }
  saveContacts(all.filter(c => c.id !== id));
  return true;
}

export async function syncContactsFromServer(): Promise<{ synced: number; pushed: number } | null> {
  if (!(await isAuthed())) return null;
  const local = loadContacts();
  const { items } = await apiClient.listContacts();
  const server = await Promise.all(items.map(contactFromDto));
  const byAddr = new Map(server.map(c => [accountKey(c.evm), c]));

  let pushed = 0;
  for (const l of local) {
    if (!l.pendingSync) continue;
    if (byAddr.has(accountKey(l.evm))) continue;
    try {
      const [encName, encNote] = await Promise.all([encryptField(l.name), encryptField(l.note)]);
      const { item } = await apiClient.createContact({
        name:        encName ?? l.name,
        address:     l.evm,
        addressType: 'evm',
        notes:       encNote ?? l.note,
      });
      byAddr.set(accountKey(l.evm), await contactFromDto(item));
      pushed++;
    } catch { /* retry next time */ }
  }
  saveContacts([...byAddr.values()]);
  return { synced: server.length, pushed };
}

export function findContactByAddress(address: string): Contact | null {
  if (!address) return null;
  const target = accountKey(address);
  return loadContacts().find(c => accountKey(c.evm) === target) ?? null;
}

export function onContactsChanged(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => cb();
  window.addEventListener('thanos:contacts-changed', handler);
  const storageHandler = (e: StorageEvent) => { if (e.key === STORAGE_KEY) cb(); };
  window.addEventListener('storage', storageHandler);
  return () => {
    window.removeEventListener('thanos:contacts-changed', handler);
    window.removeEventListener('storage', storageHandler);
  };
}
