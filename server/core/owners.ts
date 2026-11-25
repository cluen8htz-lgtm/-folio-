/**
 * Owner-of-record strings from the Property Appraiser roll, e.g.
 *   "JOHN DOE EST OF & JANE DOE"
 *   "JOHN DOE TRS & THE DOE FAMILY TRUST & MARY DOE EST OF"
 * Parties are joined by "&". A party marked EST / EST OF / ESTATE OF has
 * died; the others are living co-owners (often the spouse or heirs) or
 * trusts. The roll writes people FIRST LAST; Clerk exports often write
 * LAST, FIRST, which the comma tells apart.
 */
export interface OwnerParties {
  deceased: string[];
  living: string[];
  entities: string[];
  isEstate: boolean;
}

const DECEASED = /\b(EST(ATE)?(\s+OF)?|DECEASED|DEC'?D)\b/i;
const ENTITY = /\b(LLC|L\.L\.C|INC|CORP|CORPORATION|CO|COMPANY|TRUST|BANK|ASSOCIATION|ASSN|LTD|LP|LLP|PARTNERSHIP|HOLDINGS|PROPERTIES|INVESTMENTS|CHURCH|CITY|COUNTY|STATE)\b/i;
const NOISE = /\b(TRS|TRUSTEES?|TR|ET\s+AL|LE|REM|H\/E|JTRS|JT|C\/O)\b/gi;

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])([a-z']*)/g, (_, a: string, b: string) => a.toUpperCase() + b)
    .replace(/\bMc([a-z])/g, (_, c: string) => `Mc${c.toUpperCase()}`)
    .replace(/\b(Llc|Inc|Lp|Llp|Ii|Iii|Iv)\b/g, (m) => m.toUpperCase());
}

/** One party → "First Last" (handles "LAST, FIRST MIDDLE"). */
export function partyName(raw: string): string {
  let s = raw.replace(DECEASED, " ").replace(/\bOF\b\s*$/i, " ").replace(NOISE, " ").replace(/\s+/g, " ").trim();
  if (ENTITY.test(s)) return titleCase(s);
  if (s.includes(",")) {
    const [last, rest = ""] = s.split(/,\s*/, 2) as [string, string];
    const first = rest.split(" ")[0] ?? "";
    s = `${first} ${last}`.trim();
  }
  return titleCase(s);
}

export function parseOwner(raw: string | null | undefined): OwnerParties {
  const out: OwnerParties = { deceased: [], living: [], entities: [], isEstate: false };
  if (!raw?.trim()) return out;
  const text = raw.trim().replace(/\s+/g, " ");
  // "ESTATE OF JOHN DOE" (prefix form) with no other parties.
  const prefixed = /^ESTATE OF\s+(.+)$/i.exec(text);
  const parties = prefixed ? [`${prefixed[1]} EST`] : text.split(/\s*(?:&|\bAND\b)\s*/i);
  for (const p of parties) {
    if (!p.trim()) continue;
    if (DECEASED.test(p)) out.deceased.push(partyName(p));
    else if (ENTITY.test(p.replace(NOISE, ""))) out.entities.push(partyName(p));
    else {
      const name = partyName(p);
      // A lone "LAST, FIRST" Clerk-style owner produces one party; a bare
      // first name after "&" ("JOHN & MARY DOE") inherits the surname.
      if (name.split(" ").length === 1 && out.living.length + out.deceased.length > 0) {
        const prev = (out.living.at(-1) ?? out.deceased.at(-1))!;
        out.living.push(`${name} ${prev.split(" ").slice(1).join(" ")}`.trim());
      } else out.living.push(name);
    }
  }
  // "JOHN & MARY DOE": a leading bare first name takes the next party's surname.
  const all = [...out.living, ...out.deceased];
  out.living = out.living.map((n) => {
    if (n.includes(" ")) return n;
    const next = all.find((m) => m !== n && m.includes(" "));
    return next ? `${n} ${next.split(" ").slice(1).join(" ")}` : n;
  });
  out.isEstate = out.deceased.length > 0;
  return out;
}

/**
 * Who we write to: the first living co-owner if there is one; otherwise
 * the estate itself, which skip tracing will resolve to heirs. Never the
 * deceased owner by name.
 */
export function contactNameForOwner(raw: string | null | undefined): string | null {
  const p = parseOwner(raw);
  if (p.living[0]) return p.living[0];
  if (p.deceased[0]) return `Estate of ${p.deceased[0]}`;
  if (p.entities[0]) return p.entities[0];
  return null;
}
