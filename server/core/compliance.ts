import type { Consent } from "../db/schema";

/**
 * Outbound-message compliance checks. These are a floor, not legal advice:
 * the team should confirm them with a Florida TCPA/FTSA attorney.
 *
 * - Florida Telephone Solicitation Act (s. 501.059): solicitation calls and
 *   texts only between 8:00 and 20:00 recipient local time, and no more than
 *   3 to the same person on the same subject in 24 hours.
 * - TCPA: automated marketing texts need prior express written consent.
 *   Numbers that only came from public records or skip tracing ("none")
 *   therefore never get an automated text: a human must approve and send
 *   each one individually.
 * - National DNC: no solicitation to registered numbers without consent or
 *   an inquiry from them.
 * - STOP/opt-out is honored on every channel.
 * - CAN-SPAM: commercial email needs a postal address and an unsubscribe.
 */
export const QUIET_START_HOUR = 8;
export const QUIET_END_HOUR = 20;
export const MAX_SMS_PER_24H = 3;

export interface ComplianceInput {
  channel: "sms" | "email";
  now: Date;
  timeZone: string;
  consent: Consent;
  optedOut: boolean;
  onDncList: boolean;
  hasAddress: boolean; // phone/email present
  /** Send times of outbound SMS to this contact in the last 24h. */
  recentOutboundSms: Date[];
  businessPostalAddress?: string | null;
}

export type ComplianceResult =
  | { kind: "block"; reason: string }
  | { kind: "defer"; until: Date; reason: string }
  | { kind: "ok"; requiresHuman: boolean; notes: string[] };

export function localClock(now: Date, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { hour: get("hour"), minute: get("minute") };
}

/** Next moment the recipient's local clock reads QUIET_START_HOUR:00. */
export function nextWindowStart(now: Date, timeZone: string): Date {
  const { hour, minute } = localClock(now, timeZone);
  const minutesNow = hour * 60 + minute;
  const start = QUIET_START_HOUR * 60;
  const wait = minutesNow < start ? start - minutesNow : 24 * 60 - minutesNow + start;
  const d = new Date(now.getTime() + wait * 60_000);
  d.setSeconds(0, 0);
  return d;
}

export function checkCompliance(i: ComplianceInput): ComplianceResult {
  if (!i.hasAddress) return { kind: "block", reason: `No ${i.channel === "sms" ? "phone number" : "email address"} on file.` };
  if (i.optedOut) return { kind: "block", reason: "Contact opted out on this channel." };

  if (i.channel === "email") {
    if (!i.businessPostalAddress) {
      return { kind: "block", reason: "Set BUSINESS_POSTAL_ADDRESS: CAN-SPAM requires it in commercial email." };
    }
    return { kind: "ok", requiresHuman: i.consent === "none", notes: [] };
  }

  if (i.onDncList && i.consent === "none") {
    return { kind: "block", reason: "Number is on the Do Not Call registry and we have no consent or inquiry from them." };
  }

  const { hour } = localClock(i.now, i.timeZone);
  if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) {
    return {
      kind: "defer",
      until: nextWindowStart(i.now, i.timeZone),
      reason: "Outside 8am–8pm recipient local time (Florida FTSA).",
    };
  }

  const dayAgo = i.now.getTime() - 24 * 3600_000;
  const recent = i.recentOutboundSms.filter((d) => d.getTime() > dayAgo).sort((a, b) => a.getTime() - b.getTime());
  if (recent.length >= MAX_SMS_PER_24H) {
    const until = new Date(recent[recent.length - MAX_SMS_PER_24H]!.getTime() + 24 * 3600_000 + 60_000);
    return { kind: "defer", until, reason: `Already ${recent.length} texts in 24h (Florida FTSA limit is ${MAX_SMS_PER_24H}).` };
  }

  const notes: string[] = [];
  const requiresHuman = i.consent === "none";
  if (requiresHuman) notes.push("No consent on file: must be sent individually by a person, never automatically.");
  return { kind: "ok", requiresHuman, notes };
}

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "optout", "opt out", "opt-out"]);
const START_WORDS = new Set(["start", "unstop", "yes"]);

/** Classifies an inbound text as an opt-out, opt-in, or a normal message. */
export function classifyKeyword(body: string): "stop" | "start" | null {
  const t = body.trim().toLowerCase().replace(/[.!]+$/, "");
  if (STOP_WORDS.has(t)) return "stop";
  if (START_WORDS.has(t)) return "start";
  if (/\b(stop texting|remove me|don'?t text|do not (text|contact)|take me off)\b/.test(t)) return "stop";
  return null;
}
