// Plan dates are calendar days ("YYYY-MM-DD"), handled in UTC so no timezone can shift them.

const DAY_MS = 86_400_000;

export function toDay(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return fromDay(toDay(iso) + days);
}

export function daysBetween(a: string, b: string): number {
  return toDay(b) - toDay(a);
}

export function todayIso(): string {
  const now = new Date();
  return fromDay(Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

export function formatMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const date = `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]}`;
  return `${date} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function signedDays(n: number): string {
  if (n === 0) return "±0d";
  return `${n > 0 ? "+" : "−"}${Math.abs(n)}d`;
}

export function weekday(iso: string): number {
  // 0 = Sunday
  return (toDay(iso) + 4) % 7;
}
