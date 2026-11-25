import type { TrustLevel } from "../db/schema";

/**
 * Trust ladder: ask → draft → act.
 * - ask: the employee proposes the action; a person decides and writes it.
 * - draft: the employee writes it; a person approves or edits before it goes.
 * - act: the employee does it on its own (still subject to compliance).
 */
export type Decision = "propose" | "draft" | "execute";

export function decide(level: TrustLevel, opts: { requiresHuman: boolean }): Decision {
  if (level === "ask") return "propose";
  if (level === "draft") return "draft";
  return opts.requiresHuman ? "draft" : "execute";
}

export interface TrackRecord {
  approvedCount: number;
  editedCount: number;
  rejectedCount: number;
}

/** Suggests (never applies) a promotion once the record earns it. */
export function promotionSuggestion(level: TrustLevel, r: TrackRecord): { to: TrustLevel; why: string } | null {
  const reviewed = r.approvedCount + r.editedCount + r.rejectedCount;
  if (level === "act") return null;
  const minReviewed = level === "ask" ? 10 : 25;
  if (reviewed < minReviewed) return null;
  const cleanRate = r.approvedCount / reviewed;
  const rejectRate = r.rejectedCount / reviewed;
  if (cleanRate >= 0.9 && rejectRate <= 0.03) {
    const to: TrustLevel = level === "ask" ? "draft" : "act";
    return {
      to,
      why: `${Math.round(cleanRate * 100)}% of the last ${reviewed} were approved unchanged and ${Math.round(rejectRate * 100)}% were rejected.`,
    };
  }
  return null;
}
