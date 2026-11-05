import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderBriefingEmail } from "@/services/delivery/email-renderer";
import { runBriefing, type OrchestratorDependencies } from "@/services/orchestration/briefing-orchestrator.service";
import { SafeError } from "@/types/briefing";

export async function writeEmailPreview(
  dependencies: OrchestratorDependencies,
  directory = resolve(".intel-agent-preview"),
) {
  const result = await runBriefing("morning-briefing", "preview", { ...dependencies, delivery: undefined });
  if (!result.briefing) throw new SafeError("Briefing is disabled; no email preview generated");
  const rendered = renderBriefingEmail(result.briefing, "morning-briefing");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const htmlPath = resolve(directory, "morning-briefing.html");
  const textPath = resolve(directory, "morning-briefing.txt");
  await writeFile(htmlPath, rendered.html, { mode: 0o600 });
  await chmod(htmlPath, 0o600);
  await writeFile(textPath, rendered.text, { mode: 0o600 });
  await chmod(textPath, 0o600);
  return { htmlPath, textPath, status: result.status };
}
