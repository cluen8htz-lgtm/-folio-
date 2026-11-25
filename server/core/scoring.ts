import type { SignalType } from "../db/schema";

export interface ScoringSignal {
  type: SignalType;
  filedOn: string | null;
  amount: number | null;
}

const BASE: Record<SignalType, number> = {
  foreclosure: 35,
  probate: 25,
  tax_lien: 20,
  code_violation: 10,
};

/**
 * Motivation score, 0–100. Deterministic so it can be explained:
 * strongest signal + 15 per additional distinct signal type ("stacking"),
 * +10 for a signal filed in the last 90 days, up to +15 for lien/judgment
 * size, +10 when the owner mails elsewhere (absentee).
 */
export function scoreProperty(
  signals: ScoringSignal[],
  opts: { absentee: boolean; now?: Date },
): { score: number; reasons: string[] } {
  if (signals.length === 0) return { score: 0, reasons: [] };
  const now = opts.now ?? new Date();
  const reasons: string[] = [];
  const types = [...new Set(signals.map((s) => s.type))].sort((a, b) => BASE[b] - BASE[a]);
  let score = BASE[types[0]!];
  reasons.push(`${types[0]!.replace("_", " ")} (+${BASE[types[0]!]})`);
  for (const t of types.slice(1)) {
    score += 15;
    reasons.push(`also ${t.replace("_", " ")} (+15)`);
  }
  const recent = signals.some(
    (s) => s.filedOn && now.getTime() - new Date(s.filedOn).getTime() <= 90 * 86400_000,
  );
  if (recent) {
    score += 10;
    reasons.push("filed in last 90 days (+10)");
  }
  const owed = signals.reduce((sum, s) => sum + (s.type !== "code_violation" && s.amount ? s.amount : 0), 0);
  if (owed > 0) {
    const pts = Math.min(15, Math.round(owed / 5000));
    if (pts > 0) {
      score += pts;
      reasons.push(`$${Math.round(owed).toLocaleString("en-US")} owed (+${pts})`);
    }
  }
  if (opts.absentee) {
    score += 10;
    reasons.push("absentee owner (+10)");
  }
  return { score: Math.min(100, score), reasons };
}

export function isAbsentee(propertyAddress: string | null, mailingAddress: string | null): boolean {
  if (!propertyAddress || !mailingAddress) return false;
  // Mailing addresses usually append city/state/zip to the street line.
  const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const street = key(propertyAddress);
  return street.length > 0 && !key(mailingAddress).startsWith(street);
}
