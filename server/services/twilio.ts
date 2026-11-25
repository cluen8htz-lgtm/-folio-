import crypto from "node:crypto";
import { env } from "../env";

export interface SendResult {
  providerId: string;
  dryRun: boolean;
}

export function twilioConfigured(): boolean {
  return Boolean(
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM_NUMBER || env.TWILIO_MESSAGING_SERVICE_SID),
  );
}

/** Sends one SMS via Twilio's REST API (or logs it in dry-run mode). */
export async function sendSms(to: string, body: string): Promise<SendResult> {
  if (env.twilioDryRun || !twilioConfigured()) {
    console.log(`[twilio dry-run] to=${to} body=${JSON.stringify(body)}`);
    return { providerId: `dry_${crypto.randomUUID()}`, dryRun: true };
  }
  const form = new URLSearchParams({ To: to, Body: body });
  if (env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set("From", env.TWILIO_FROM_NUMBER!);
  form.set("StatusCallback", `${env.PUBLIC_URL}/webhooks/twilio/status`);
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const json = (await res.json()) as { sid?: string; message?: string; code?: number };
  if (!res.ok || !json.sid) throw new Error(`Twilio ${res.status}: ${json.message ?? "unknown error"} (${json.code ?? ""})`);
  return { providerId: json.sid, dryRun: false };
}

/**
 * Twilio request validation: base64(HMAC-SHA1(authToken, url + each POST
 * param name+value sorted by name)), compared in constant time.
 */
export function computeTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(computeTwilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
