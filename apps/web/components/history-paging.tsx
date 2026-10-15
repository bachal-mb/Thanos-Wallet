'use client';
/**
 * Period filter + pager for the transaction lists (dashboard Payment history,
 * Transactions page). History now comes from every network's explorer, so a
 * list can hold hundreds of rows — show them a page at a time instead of
 * capping at the newest few (client 2026-10-15).
 */
import React from 'react';

export type HistoryPeriod = 'all' | '7d' | '30d' | '90d';

const PERIODS: Array<[HistoryPeriod, string, number]> = [
  ['all', 'All time', 0],
  ['7d', 'Last 7 days', 7],
  ['30d', 'Last 30 days', 30],
  ['90d', 'Last 90 days', 90],
];

export function periodLabel(p: HistoryPeriod): string {
  return PERIODS.find(([id]) => id === p)?.[1] ?? 'All time';
}

/** Whether a row's time (ISO string or epoch ms) falls in the period. A row
 *  without a time (a send still being broadcast) counts as now. */
export function inPeriod(ts: string | number | undefined, p: HistoryPeriod): boolean {
  const days = PERIODS.find(([id]) => id === p)?.[2] ?? 0;
  if (!days) return true;
  const t = typeof ts === 'number' ? ts : ts ? Date.parse(ts) : Date.now();
  return !Number.isFinite(t) || Date.now() - t <= days * 86_400_000;
}

export function PeriodSelect({ value, onChange }: { value: HistoryPeriod; onChange: (p: HistoryPeriod) => void }) {
  return (
    <select
      className="chart-selector"
      aria-label="Show transactions from"
      value={value}
      onChange={(e) => onChange(e.target.value as HistoryPeriod)}
    >
      {PERIODS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
    </select>
  );
}

/** "1–6 of 70" with Previous / Next. Renders nothing for a single page. */
export function Pager({ page, pageSize, total, onPage }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, from + pageSize - 1);
  return (
    <div className="pager">
      <span className="pager-count">{from}–{to} of {total}</span>
      <div className="pager-buttons">
        <button type="button" className="chart-selector" disabled={page === 0} onClick={() => onPage(page - 1)}>‹ Previous</button>
        <span className="pager-page">Page {page + 1} of {pages}</span>
        <button type="button" className="chart-selector" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next ›</button>
      </div>
    </div>
  );
}
