type LogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly LogValue[]
  | { readonly [key: string]: LogValue };
export type LogFields = Record<string, LogValue>;
type Level = "info" | "warn" | "error";

/**
 * Structured JSON logs. Callers must pass only safe metadata: never secrets,
 * tokens, recipient addresses, calendar contents or raw provider responses.
 */
function write(level: Level, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export const logger = {
  info: (event: string, fields?: LogFields) => write("info", event, fields),
  warn: (event: string, fields?: LogFields) => write("warn", event, fields),
  error: (event: string, fields?: LogFields) => write("error", event, fields),
};
