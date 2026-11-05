import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceRoot = new URL("../src/", import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { url: new URL(`${specifier.slice(2)}.ts`, sourceRoot).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith(sourceRoot.href) || !url.endsWith(".ts")) return nextLoad(url, context);
    return {
      format: "module",
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      shortCircuit: true,
    };
  },
});

const { getServerEnv, ConfigError } = await import("../src/config/env.ts");
const { createBriefingDependencies } = await import("../src/services/orchestration/dependencies.ts");
const { writeEmailPreview } = await import("../src/services/delivery/local-email-preview.ts");
const { SafeError } = await import("../src/types/briefing.ts");

try {
  const env = getServerEnv({
    ...process.env,
    APP_ENV: "local",
    EMAIL_SEND_ENABLED: "false",
    MARKETS_ENABLED: process.env.MARKETS_ENABLED ?? (process.env.TWELVE_DATA_API_KEY?.trim() ? "true" : "false"),
  });
  const preview = await writeEmailPreview(createBriefingDependencies(env));
  console.log(`Email preview saved: ${preview.htmlPath}`);
  console.log(`Plain text saved: ${preview.textPath}`);
  console.log(`Status: ${preview.status}. No email sent. Files contain private data; do not share or commit them.`);
} catch (error) {
  console.error(error instanceof ConfigError || error instanceof SafeError
    ? error.message : "Local email preview failed; check configuration and local file permissions.");
  process.exitCode = 1;
}
