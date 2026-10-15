/**
 * Extension address book — same hybrid local-cache + cloud-sync model
 * as apps/web/lib/address-book.ts.
 *
 * - Authenticated: `/contacts` API is source of truth; CRUD writes
 *   through; local cache mirrors for the synchronous reads the popup
 *   needs.
 * - Unauthenticated: localStorage only, with `pendingSync: true` so the
 *   next successful sync flushes the queued items up.
 *
 * Contact name + notes are encrypted client-side via contact-crypto.ts
 * before they ever leave the device. The address stays plaintext (server
 * dedup on lower(address); addresses are public on-chain anyway).
 */
import { getAddress } from 'ethers';
import { evmToLitho, lithoToEvm, isLithoAddress } from '@thanos/sdk-core';
import { apiClient } from './auth-client';
import type { ContactDto } from '@thanos/api-client';
import { encryptField, decryptField } from './contact-crypto';

const STORAGE_KEY = 'thanos.address_book';

export interface Contact {
  id:          string;
  name:        string;
  evm:         string;
  /** litho1… form of the same account — what the popup shows. */
  litho?:      string;
  note?:       string;
  updatedAt:   number;
  pendingSync?: boolean;
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

/** litho1… for a 0x address; undefined for anything else (evmToLitho throws
 *  on non-0x input, which used to fail the whole add / sync). */
function lithoOf(evm: string): string | undefined {
  try { return evmToLitho(evm); } catch { return undefined; }
}

/** 0x (checksummed) for a 0x or litho1… address; null for anything else. */
function evmOf(address: string): string | null {
  const a = address.trim();
  try {
    if (/^0x[0-9a-fA-F]{40}$/.test(a)) return getAddress(a);
    if (isLithoAddress(a.toLowerCase())) return getAddress(lithoToEvm(a.toLowerCase()));
  } catch { /* malformed */ }
  return null;
}

function saveContacts(list: Contact[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  try { window.dispatchEvent(new CustomEvent('thanos:contacts-changed')); } catch { /* no-op */ }
}

async function contactFromDto(d: ContactDto): Promise<Contact> {
  // A row saved as litho1… is the same 0x account; anything else (a non-EVM
  // address the server may hold) is kept as-is.
  const evm = evmOf(d.address) ?? d.address;
  const [name, note] = await Promise.all([decryptField(d.name), decryptField(d.notes)]);
  return {
    id:        d.id,
    name:      name ?? d.name,
    evm,
    litho:     lithoOf(evm),
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

  // litho1… or 0x — one account either way, kept in both forms (litho / evm).
  // The cloud row carries the 0x form: it's the one every Thanos client's
  // contact sync parses (desktop's throws on a litho1… row).
  const evm = evmOf(input.address);
  if (!evm) throw new Error('Enter a litho1… or 0x… address');
  const litho = lithoOf(evm);

  const all = loadContacts();
  if (all.some(c => c.evm.toLowerCase() === evm.toLowerCase())) throw new Error('Address already in your contacts');

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
    litho,
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
  const serverContacts = await Promise.all(items.map(contactFromDto));
  const byAddr = new Map(serverContacts.map(c => [c.evm.toLowerCase(), c]));

  let pushed = 0;
  for (const l of local) {
    if (!l.pendingSync) continue;
    if (byAddr.has(l.evm.toLowerCase())) continue;
    try {
      const [encName, encNote] = await Promise.all([encryptField(l.name), encryptField(l.note)]);
      const { item } = await apiClient.createContact({
        name:        encName ?? l.name,
        address:     l.evm,
        addressType: 'evm',
        notes:       encNote ?? l.note,
      });
      byAddr.set(l.evm.toLowerCase(), await contactFromDto(item));
      pushed++;
    } catch { /* retry next time */ }
  }
  saveContacts([...byAddr.values()]);
  return { synced: serverContacts.length, pushed };
}

export function findContactByAddress(address: string): Contact | null {
  if (!address) return null;
  // litho1… or 0x — both name the same contact.
  const target = (evmOf(address) ?? address).toLowerCase();
  return loadContacts().find(c => c.evm.toLowerCase() === target) ?? null;
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
