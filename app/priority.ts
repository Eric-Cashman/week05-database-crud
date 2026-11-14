export type Priority = 'high' | 'medium' | 'low';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Thresholds, in whole calendar days from today.
// Overdue tasks count as high because their day count is negative.
export const HIGH_WITHIN_DAYS = 3;
export const MEDIUM_WITHIN_DAYS = 7;

function dayNumberFromDue(due: string | Date): number | null {
  const t = typeof due === 'string' ? Date.parse(due) : due.getTime();
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  // Due dates are stored as UTC calendar dates (SQL DATE as 'YYYY-MM-DD',
  // Mongo as a Date at UTC midnight), so read the UTC parts.
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / MS_PER_DAY);
}

function dayNumberForToday(now: Date): number {
  // "Today" is the server's local calendar day.
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY);
}

// Priority is derived at read time, never stored, so it cannot go stale.
export function priorityFor(
  due: string | Date | null | undefined,
  now: Date = new Date()
): Priority {
  if (due === null || due === undefined) return 'low';
  const dueDay = dayNumberFromDue(due);
  if (dueDay === null) return 'low';
  const days = dueDay - dayNumberForToday(now);
  if (days <= HIGH_WITHIN_DAYS) return 'high';
  if (days <= MEDIUM_WITHIN_DAYS) return 'medium';
  return 'low';
}
