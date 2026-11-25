import crypto from "node:crypto";
import { env } from "../env";

/** CAN-SPAM footer: who we are, where we are, how to stop. */
export function emailFooter(unsubscribeUrl: string): string {
  return `\n\n—\n${env.BUSINESS_POSTAL_ADDRESS ?? ""}\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}`;
}

export function unsubscribeToken(contactId: number): string {
  return crypto.createHmac("sha256", env.APP_SECRET).update(`unsub:${contactId}`).digest("hex").slice(0, 32);
}

export function unsubscribeUrl(contactId: number): string {
  return `${env.PUBLIC_URL}/webhooks/unsubscribe/${contactId}/${unsubscribeToken(contactId)}`;
}

/** Sends via a Resend-compatible HTTP API, or logs when not configured. */
export async function sendEmail(to: string, subject: string, text: string): Promise<{ providerId: string; dryRun: boolean }> {
  if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) {
    console.log(`[email dry-run] to=${to} subject=${JSON.stringify(subject)}`);
    return { providerId: `dry_${crypto.randomUUID()}`, dryRun: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text }),
  });
  const json = (await res.json()) as { id?: string; message?: string };
  if (!res.ok || !json.id) throw new Error(`Email ${res.status}: ${json.message ?? "unknown error"}`);
  return { providerId: json.id, dryRun: false };
}
