import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === "" ? undefined : ["1", "true", "yes"].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default("./data/pglite"),
  APP_SECRET: z.string().default("dev-secret"),
  APP_PASSWORD: z.string().default("folio"),
  PUBLIC_URL: z.string().default("http://localhost:3000"),
  TEAM_NAME: z.string().default("our team"),
  TEAM_TIMEZONE: z.string().default("America/New_York"),
  ANTHROPIC_API_KEY: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  TWILIO_DRY_RUN: bool,
  EMAIL_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  BUSINESS_POSTAL_ADDRESS: z.string().optional(),
  MDC_CODE_VIOLATIONS_LAYER_URL: z.string().optional(),
  IMPORT_DAILY_AT: z.string().default("06:00"),
});

const raw = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, v === "" ? undefined : v]));
// Railway exposes the service's public domain; use it when PUBLIC_URL isn't set.
if (!raw.PUBLIC_URL && raw.RAILWAY_PUBLIC_DOMAIN) raw.PUBLIC_URL = `https://${raw.RAILWAY_PUBLIC_DOMAIN}`;
const parsed = schema.parse(raw);

export const env = {
  ...parsed,
  isProd: parsed.NODE_ENV === "production",
  twilioDryRun: parsed.TWILIO_DRY_RUN ?? true,
};

if (env.isProd) {
  const problems: string[] = [];
  if (env.APP_SECRET === "dev-secret" || env.APP_SECRET.length < 32) problems.push("APP_SECRET must be a random string of 32+ characters.");
  if (env.APP_PASSWORD === "folio" || env.APP_PASSWORD.length < 12) problems.push("APP_PASSWORD must be 12+ characters.");
  // Without Postgres, data would live on the container's disk and vanish on redeploy.
  if (!env.DATABASE_URL && process.env.ALLOW_EMBEDDED_DB !== "true") problems.push("DATABASE_URL is required in production.");
  if (problems.length) throw new Error(`Folio can't start:\n- ${problems.join("\n- ")}`);
  if (env.PUBLIC_URL.includes("localhost")) console.warn("PUBLIC_URL is localhost: Twilio webhooks will fail signature checks.");
}
