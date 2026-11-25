/** Miami-Dade folios are 13 digits, often written 01-3125-034-0010. */
export function normalizeFolio(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 13) return digits;
  // Spreadsheets drop the leading zero of folios that start with 0.
  if (digits.length === 12) return `0${digits}`;
  return null;
}

export function formatFolio(folio: string): string {
  return folio.length === 13
    ? `${folio.slice(0, 2)}-${folio.slice(2, 6)}-${folio.slice(6, 9)}-${folio.slice(9)}`
    : folio;
}

/** US numbers to E.164 (+1XXXXXXXXXX); null if it can't be a US number. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Accepts YYYY-MM-DD, MM/DD/YYYY, epoch ms; returns YYYY-MM-DD or null. */
export function normalizeDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return new Date(raw).toISOString().slice(0, 10);
  const s = String(raw).trim();
  // ArcGIS and other JSON APIs send dates as epoch milliseconds.
  if (/^-?\d{11,14}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  return null;
}

export function parseMoney(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(String(raw).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const ENTITY = /\b(LLC|L\.L\.C|INC|CORP|CORPORATION|CO|COMPANY|TRUST|TRUSTEE|TR|ESTATE|EST|BANK|ASSOCIATION|ASSN|LTD|LP|LLP|PARTNERSHIP|HOLDINGS|PROPERTIES|INVESTMENTS|CHURCH|CITY|COUNTY)\b/i;

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])([a-z']*)/g, (_, a: string, b: string) => a.toUpperCase() + b)
    .replace(/\bMc([a-z])/g, (_, c: string) => `Mc${c.toUpperCase()}`)
    .replace(/\b(Llc|Inc|Lp|Llp)\b/g, (m) => m.toUpperCase());
}

/**
 * Public records list people as "LAST, FIRST MIDDLE". Turn that into
 * "First Last" for messages; leave companies, trusts and estates whole.
 */
export function personName(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const s = raw.trim().replace(/\s+/g, " ");
  if (ENTITY.test(s)) return titleCase(s);
  // Multiple owners ("SMITH, JOHN & MARY"): keep the first person.
  const [last, rest] = s.split(/,\s*/, 2) as [string, string | undefined];
  if (!rest) return titleCase(s);
  const first = rest.split(/\s*(?:&|\bAND\b)\s*/i)[0]!.split(" ")[0]!;
  return titleCase(`${first} ${last}`);
}
