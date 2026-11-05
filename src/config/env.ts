import { z } from "zod";

/** Optional integration secret: blank values are treated as unset. */
const optionalSecret = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const serverEnvSchema = z.object({
  APP_ENV: z.enum(["local", "dev", "prod"]).default("local"),
  CRON_SECRET: z.string().min(32, "must be at least 32 characters"),
  GOOGLE_CLIENT_ID: optionalSecret,
  GOOGLE_CLIENT_SECRET: optionalSecret,
  GOOGLE_REFRESH_TOKEN: optionalSecret,
  GOOGLE_CALENDAR_ID: optionalSecret,
  GOOGLE_CALENDAR_MODE: z.enum(["single", "owned"]).optional(),
  GNEWS_API_KEY: optionalSecret,
  RESEND_API_KEY: optionalSecret,
  EMAIL_FROM: optionalSecret,
  EMAIL_TO: optionalSecret,
  EMAIL_SEND_ENABLED: z.enum(["true", "false"]).optional(),
  TWELVE_DATA_API_KEY: optionalSecret,
  MARKETS_ENABLED: z.enum(["true", "false"]).optional(),
}).superRefine((env, context) => {
  if (env.MARKETS_ENABLED === "true" && !env.TWELVE_DATA_API_KEY) {
    context.addIssue({ code: "custom", path: ["TWELVE_DATA_API_KEY"], message: "required when markets are enabled" });
  }
  if (env.EMAIL_FROM && !/^Intel-Agent <[^<>\r\n]+>$/.test(env.EMAIL_FROM)) {
    context.addIssue({ code: "custom", path: ["EMAIL_FROM"], message: "must use Intel-Agent <address>" });
  }
  const fromAddress = env.EMAIL_FROM?.match(/^Intel-Agent <([^<>]+)>$/)?.[1];
  if (env.EMAIL_FROM && (!fromAddress || !z.email().safeParse(fromAddress).success)) {
    context.addIssue({ code: "custom", path: ["EMAIL_FROM"], message: "must contain a valid email" });
  }
  if (env.EMAIL_TO && !z.email().safeParse(env.EMAIL_TO).success) {
    context.addIssue({ code: "custom", path: ["EMAIL_TO"], message: "must be a valid email" });
  }
  if (env.EMAIL_SEND_ENABLED === "true") {
    for (const key of ["RESEND_API_KEY", "EMAIL_FROM", "EMAIL_TO"] as const) {
      if (!env[key]) context.addIssue({ code: "custom", path: [key], message: "required when sending is enabled" });
    }
  }
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class ConfigError extends Error {
  constructor(readonly invalidVariables: string[]) {
    // Names only: values are never included in messages or logs.
    super(`Invalid or missing environment variables: ${invalidVariables.join(", ")}`);
    this.name = "ConfigError";
  }
}

/**
 * Validates server configuration at request time, so building the static
 * site never requires production secrets.
 */
export function getServerEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "unknown")))];
    throw new ConfigError(names);
  }
  return result.data;
}
