"use strict";

// Builds the single weekly dependency pull request. It only rewrites the manifest,
// lockfile (npm with --package-lock-only --ignore-scripts) and pinned action SHAs,
// so no third-party package code runs with the write token.

const { execFileSync } = require("node:child_process");
const {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const npmDirectories = ["."];
const workflowDirectory = ".github/workflows";
const stable = /^\d+\.\d+\.\d+$/;
const simpleSpecifier = /^([~^]?)(\d+\.\d+\.\d+)$/;
const pinnedAction =
  /uses:\s*([\w.-]+\/[\w.-]+)((?:\/[\w./-]+)?)@([a-f0-9]{40})\s+#\s*(v?\d+\.\d+\.\d+)/g;

// Major upgrades that need deliberate work. Minor and patch updates still apply.
const heldMajors = new Map([
  ["@types/node", "Types must match the Node 24 LTS runtime."],
  ["typescript", "typescript-eslint requires TypeScript 6; review compiler API support before upgrading."],
]);

function parse(version) {
  return version.replace(/^v/, "").split(".").map(Number);
}

function compare(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index++) {
    if (x[index] !== y[index]) return x[index] - y[index];
  }
  return 0;
}

function updateType(from, to) {
  const [x, y] = [parse(from), parse(to)];
  if (x[0] !== y[0]) return "major";
  if (x[1] !== y[1]) return "minor";
  return "patch";
}

function planNpm(manifest, lock, latest) {
  const updates = [];
  const held = [];
  for (const section of ["dependencies", "devDependencies"]) {
    for (const [name, current] of Object.entries(manifest[section] ?? {})) {
      const match = simpleSpecifier.exec(current);
      const installed = lock.packages?.[`node_modules/${name}`]?.version;
      const available = latest.get(name);
      if (
        !match ||
        !stable.test(installed ?? "") ||
        !stable.test(available ?? "")
      ) {
        continue;
      }
      if (compare(available, installed) <= 0) continue;
      const type = updateType(installed, available);
      if (type === "major" && heldMajors.has(name)) {
        held.push({ name, installed, available, reason: heldMajors.get(name) });
        continue;
      }
      updates.push({
        name,
        section,
        from: installed,
        to: available,
        type,
        specifier: `${match[1]}${available}`,
      });
    }
  }
  return { updates, held };
}

function actionPins(source) {
  return [...source.matchAll(pinnedAction)].map((match) => ({
    repository: match[1],
    subpath: match[2],
    sha: match[3],
    tag: match[4],
  }));
}

function replaceActionPin(source, pin, sha, tag) {
  const from = `${pin.repository}${pin.subpath}@${pin.sha}`;
  return source.replace(
    new RegExp(`${escape(from)}(\\s+#\\s*)${escape(pin.tag)}`, "g"),
    `${pin.repository}${pin.subpath}@${sha}$1${tag}`,
  );
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function table(headers, rows) {
  if (rows.length === 0) return "";
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ].join("\n");
}

function summary({
  applied,
  held,
  failed,
  majorActions,
  manualActions = [],
  audits,
  problems,
  date,
}) {
  const sections = [
    "## Weekly dependency updates",
    "",
    `Generated ${date}. Every update below is applied in this one pull request. Review the`,
    "changes and CI results, then merge; merging deploys development. The next Monday run",
    "replaces this branch, so merge or close it before then.",
    "",
    "Lockfiles were also refreshed within existing version ranges, which picks up patch and",
    "security fixes for indirect dependencies.",
    "",
  ];
  sections.push("### Applied", "");
  sections.push(
    applied.length === 0
      ? "No direct dependency version changes; lockfile refresh only.\n"
      : table(
          ["Area", "Package", "From", "To", "Type"],
          applied.map((item) => [
            item.area,
            `\`${item.name}\``,
            item.from,
            item.to,
            item.type === "major" ? "**major**" : item.type,
          ]),
        ),
  );
  if (manualActions.length > 0) {
    sections.push("### GitHub Actions updates to apply by hand", "");
    sections.push(
      "The default workflow token cannot edit workflow files. Replace these pins in",
      "`.github/workflows/` (or add the `DEPENDENCY_UPDATE_TOKEN` secret to automate them).",
      "",
    );
    sections.push(
      table(
        ["Action", "From", "To", "Pin"],
        manualActions.map((item) => [
          `\`${item.name}\``,
          item.from,
          item.to,
          `\`${item.sha} # ${item.to}\``,
        ]),
      ),
    );
  }
  if (held.length + majorActions.length > 0) {
    sections.push("### Held back (upgrade deliberately)", "");
    sections.push(
      table(
        ["Area", "Package", "Current", "Available", "Reason"],
        [
          ...held.map((item) => [
            item.area,
            `\`${item.name}\``,
            item.installed,
            item.available,
            item.reason,
          ]),
          ...majorActions.map((item) => [
            "GitHub Actions",
            `\`${item.repository}\``,
            item.tag,
            item.available,
            "Major action releases can change inputs; update the pin by hand.",
          ]),
        ],
      ),
    );
  }
  if (failed.length > 0) {
    sections.push("### Could not apply automatically", "");
    sections.push(
      table(
        ["Area", "Package", "Wanted", "Error"],
        failed.map((item) => [
          item.area,
          `\`${item.name}\``,
          item.to,
          item.error.replace(/\|/g, "\\|"),
        ]),
      ),
    );
  }
  if (audits.length > 0) {
    sections.push("### Production security audit after updates", "");
    sections.push(
      table(
        ["Area", "Critical", "High", "Moderate", "Low"],
        audits.map((item) => [
          item.area,
          item.counts.critical,
          item.counts.high,
          item.counts.moderate,
          item.counts.low,
        ]),
      ),
    );
  }
  if (problems.length > 0) {
    sections.push(
      "### Problems",
      "",
      ...problems.map((problem) => `- ${problem}`),
      "",
    );
  }
  return sections.join("\n");
}

function childEnvironment() {
  const environment = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
  delete environment.GH_TOKEN;
  delete environment.GITHUB_TOKEN;
  return environment;
}

function run(command, args, cwd) {
  try {
    const output = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnvironment(),
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, output };
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    const line =
      output
        .split("\n")
        .find((text) => /npm error (?!code)|ERR_|Error:/.test(text)) ??
      output.trim().split("\n").at(-1) ??
      String(error.message);
    return { ok: false, output, error: line.trim().slice(0, 200) };
  }
}

const npmFlags = [
  "--package-lock-only",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
];

async function latestVersion(name) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
    { signal: AbortSignal.timeout(15_000), redirect: "error" },
  );
  if (!response.ok) throw new Error(`npm registry HTTP ${response.status}`);
  const metadata = await response.json();
  if (metadata.name !== name)
    throw new Error("npm registry returned another package");
  return metadata.version;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

async function updateNpm(directory, result) {
  const area = directory === "." ? "root" : directory;
  const cwd = path.join(root, directory);
  const manifestPath = path.join(cwd, "package.json");
  const lockPath = path.join(cwd, "package-lock.json");
  if (!existsSync(manifestPath)) {
    result.problems.push(
      `${area}: no package.json yet; npm updates skipped until the application is scaffolded.`,
    );
    return;
  }

  const refreshed = run("npm", ["update", ...npmFlags], cwd);
  if (!refreshed.ok)
    result.problems.push(`${area}: npm update failed: ${refreshed.error}`);

  const manifest = readJson(manifestPath);
  const names = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  });
  const latest = new Map();
  for (const name of names) {
    try {
      latest.set(name, await latestVersion(name));
    } catch (error) {
      result.problems.push(
        `${area}: could not look up ${name}: ${error.message}`,
      );
    }
  }
  const plan = planNpm(manifest, readJson(lockPath), latest);
  result.held.push(...plan.held.map((item) => ({ ...item, area })));

  const original = readFileSync(manifestPath, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const write = (updates) => {
    const next = JSON.parse(original);
    for (const update of updates)
      next[update.section][update.name] = update.specifier;
    writeFileSync(
      manifestPath,
      `${JSON.stringify(next, null, 2)}\n`.replace(/\n/g, newline),
    );
  };

  if (plan.updates.length > 0) {
    write(plan.updates);
    if (run("npm", ["install", ...npmFlags], cwd).ok) {
      result.applied.push(...plan.updates.map((item) => ({ ...item, area })));
    } else {
      // Apply one at a time so a single incompatible release doesn't block the rest.
      const accepted = [];
      for (const update of plan.updates) {
        write([...accepted, update]);
        const attempt = run("npm", ["install", ...npmFlags], cwd);
        if (attempt.ok) {
          accepted.push(update);
        } else {
          result.failed.push({ ...update, area, error: attempt.error });
        }
      }
      write(accepted);
      run("npm", ["install", ...npmFlags], cwd);
      result.applied.push(...accepted.map((item) => ({ ...item, area })));
    }
  }

  const fixed = run("npm", ["audit", "fix", ...npmFlags], cwd);
  if (!fixed.ok && !/vulnerabilit/i.test(fixed.output)) {
    result.problems.push(`${area}: npm audit fix failed: ${fixed.error}`);
  }

  const audit = run("npm", ["audit", "--omit=dev", "--json"], cwd);
  try {
    const counts = JSON.parse(audit.output.slice(audit.output.indexOf("{")))
      .metadata.vulnerabilities;
    result.audits.push({ area, counts });
  } catch {
    result.problems.push(`${area}: audit results could not be read.`);
  }
}

async function github(pathname) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GH_TOKEN)
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`GitHub API HTTP ${response.status} for ${pathname}`);
  return response.json();
}

async function updateActions(result, apply) {
  const directory = path.join(root, workflowDirectory);
  const files = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name));
  const sources = new Map(
    files.map((name) => [
      name,
      readFileSync(path.join(directory, name), "utf8"),
    ]),
  );
  const pins = new Map();
  for (const source of sources.values()) {
    for (const pin of actionPins(source))
      pins.set(`${pin.repository}${pin.subpath}@${pin.sha}`, pin);
  }
  const releases = new Map();
  for (const pin of pins.values()) {
    try {
      if (!releases.has(pin.repository)) {
        const release = await github(
          `/repos/${pin.repository}/releases/latest`,
        );
        if (!/^v?\d+\.\d+\.\d+$/.test(release.tag_name)) continue;
        const commit = await github(
          `/repos/${pin.repository}/commits/${encodeURIComponent(release.tag_name)}`,
        );
        releases.set(pin.repository, {
          tag: release.tag_name,
          sha: commit.sha,
        });
      }
      const latest = releases.get(pin.repository);
      if (!latest || compare(latest.tag, pin.tag) <= 0) continue;
      if (updateType(pin.tag, latest.tag) === "major") {
        if (
          !result.majorActions.some(
            (item) => item.repository === pin.repository,
          )
        ) {
          result.majorActions.push({ ...pin, available: latest.tag });
        }
        continue;
      }
      const update = {
        area: "GitHub Actions",
        name: `${pin.repository}${pin.subpath}`,
        from: pin.tag,
        to: latest.tag,
        type: updateType(pin.tag, latest.tag),
        sha: latest.sha,
      };
      if (apply) {
        for (const [name, source] of sources) {
          sources.set(
            name,
            replaceActionPin(source, pin, latest.sha, latest.tag),
          );
        }
        result.applied.push(update);
      } else {
        result.manualActions.push(update);
      }
    } catch (error) {
      result.problems.push(
        `GitHub Actions: could not check ${pin.repository}: ${error.message}`,
      );
    }
  }
  if (apply) {
    for (const [name, source] of sources)
      writeFileSync(path.join(directory, name), source);
  }
}

async function main() {
  const output = process.argv[2];
  if (!output) {
    throw new Error(
      "Usage: weekly-dependency-update.cjs <summary-file> [--apply-actions]",
    );
  }
  const result = {
    applied: [],
    held: [],
    failed: [],
    majorActions: [],
    manualActions: [],
    audits: [],
    problems: [],
  };
  for (const directory of npmDirectories) await updateNpm(directory, result);
  await updateActions(result, process.argv.includes("--apply-actions"));
  writeFileSync(
    output,
    summary({ ...result, date: new Date().toISOString().slice(0, 10) }),
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  actionPins,
  heldMajors,
  planNpm,
  replaceActionPin,
  summary,
  updateType,
};
