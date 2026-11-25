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

const parsed = schema.parse(
  Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, v === "" ? undefined : v])),
);

export const env = {
  ...parsed,
  isProd: parsed.NODE_ENV === "production",
  twilioDryRun: parsed.TWILIO_DRY_RUN ?? true,
};

if (env.isProd && (env.APP_SECRET === "dev-secret" || env.APP_PASSWORD === "folio")) {
  throw new Error("Set APP_SECRET and APP_PASSWORD in production.");
}
