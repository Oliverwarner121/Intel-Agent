import { z } from "zod";

const serverEnvSchema = z.object({
  APP_ENV: z.enum(["local", "dev", "prod"]).default("local"),
  CRON_SECRET: z.string().min(32, "must be at least 32 characters"),
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
