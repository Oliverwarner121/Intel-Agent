const marker = "<!-- intel-agent-dependency-report -->";
const directories = [""];
const stable = /^\d+\.\d+\.\d+$/;
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/;

function dependencies(manifest, lock) {
  if (manifest.private !== true) {
    throw new Error("Expected a private application manifest");
  }
  return Object.entries({
    ...manifest.devDependencies,
    ...manifest.dependencies,
  }).map(([name, range]) => {
    if (
      name.length > 214 ||
      !packageName.test(name) ||
      typeof range !== "string" ||
      !/^[~^<>=*|\d.\sxXv+-]+$/.test(range)
    ) {
      throw new Error("Unsupported dependency name or non-registry version");
    }
    return {
      name,
      range,
      installed: lock.packages?.[`node_modules/${name}`]?.version,
    };
  });
}

function row(directory, name, installed, latest, advisoryCount) {
  const recommendation =
    advisoryCount === null
      ? "Advisory check unavailable; not recommended automatically"
      : advisoryCount > 0
        ? `${advisoryCount} known advisories; do not upgrade blindly`
        : "No known GitHub advisories for this version; test compatibility";
  return `| ${directory || "root"} | \`${name}\` | ${installed} | ${latest} | ${recommendation} |`;
}

async function report({
  github,
  context,
  core,
  fetchPackage = async (name) => {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
      {
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error(`npm registry HTTP ${response.status}`);
    return response.json();
  },
}) {
  const { owner, repo } = context.repo;
  const pull = context.payload.pull_request;
  const rows = [];
  const problems = [];
  let inspected = 0;
  let scaffolded = true;
  async function json(path) {
    const response = await github.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: pull.head.sha,
    });
    if (
      Array.isArray(response.data) ||
      response.data.type !== "file" ||
      response.data.encoding !== "base64" ||
      response.data.size > 2_000_000
    ) {
      throw new Error(
        "Dependency file is missing, oversized or not a regular file",
      );
    }
    return JSON.parse(
      Buffer.from(response.data.content, "base64").toString("utf8"),
    );
  }
  for (const directory of directories) {
    const prefix = directory ? `${directory}/` : "";
    const area = directory || "root";
    let entries;
    try {
      await json(`${prefix}package.json`);
    } catch (error) {
      if (error?.status === 404) {
        scaffolded = false;
        continue;
      }
    }
    try {
      const [manifest, lock] = await Promise.all([
        json(`${prefix}package.json`),
        json(`${prefix}package-lock.json`),
      ]);
      entries = dependencies(manifest, lock);
      if (entries.length > 150)
        throw new Error("More than 150 direct dependencies");
    } catch {
      problems.push(
        `${area}: dependency files could not be validated; report incomplete.`,
      );
      continue;
    }
    for (const entry of entries) {
      if (!stable.test(entry.installed ?? "")) {
        problems.push(
          `${area}: ${entry.name} has no stable installed version in the lockfile.`,
        );
        continue;
      }
      try {
        const metadata = await fetchPackage(entry.name);
        if (
          metadata.name !== entry.name ||
          !stable.test(metadata.version) ||
          metadata.deprecated
        ) {
          throw new Error("npm latest is not a stable version");
        }
        inspected++;
        if (metadata.version === entry.installed) continue;
        const installedParts = entry.installed.split(".").map(Number);
        const latestParts = metadata.version.split(".").map(Number);
        const firstDifference = latestParts.findIndex(
          (part, index) => part !== installedParts[index],
        );
        if (
          firstDifference < 0 ||
          latestParts[firstDifference] < installedParts[firstDifference]
        )
          continue;
        let count = null;
        try {
          const advisories = await github.paginate(
            github.rest.securityAdvisories.listGlobalAdvisories,
            {
              ecosystem: "npm",
              affects: `${entry.name}@${metadata.version}`,
              per_page: 100,
            },
          );
          count = advisories.filter(
            (advisory) => !advisory.withdrawn_at,
          ).length;
        } catch {
          problems.push(
            `${area}: advisory lookup unavailable for ${entry.name}.`,
          );
        }
        rows.push(
          row(directory, entry.name, entry.installed, metadata.version, count),
        );
      } catch {
        problems.push(
          `${area}: public registry lookup unavailable for ${entry.name}.`,
        );
      }
    }
  }
  const body = [
    marker,
    "## Dependency update report (informational)",
    `Snapshot for commit \`${pull.head.sha}\`. Checked ${inspected} direct packages against npm's latest stable tag.`,
    "This report never installs PR code, upgrades packages, or blocks deployment. Do not make this check required in branch protection.",
    "Scope: root direct npm dependencies, including dev dependencies. Transitive dependencies and GitHub Actions updates are not listed here.",
    "Latest stable does **not** guarantee safety or compatibility. Advisory checks cover the candidate's direct package only, not its transitive dependency tree. Dependabot alerts complement this report.",
    !scaffolded
      ? "No `package.json` yet; the application has not been scaffolded, so there is nothing to report."
      : rows.length
      ? [
          "| Project | Package | Locked version | Latest stable | Advisory check |",
          "|---|---|---|---|---|",
          ...rows,
        ].join("\n")
      : "No newer stable versions found among successfully checked packages.",
    problems.length
      ? `### Incomplete checks / limitations\n${problems
          .slice(0, 20)
          .map((problem) => `- ${problem}`)
          .join(
            "\n",
          )}${problems.length > 20 ? `\n- ${problems.length - 20} additional checks were incomplete.` : ""}`
      : "",
    "Routine upgrades arrive in the weekly `deps/weekly` pull request. Review changes and run the application tests before upgrading.",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (body.length > 60_000) {
    throw new Error(
      "Dependency report exceeds the comment size limit; reduce the report scope.",
    );
  }
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pull.number,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) =>
      comment.user?.login === "github-actions[bot]" &&
      comment.body?.startsWith(marker),
  );
  if (existing) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: pull.number,
      body,
    });
  }
  if (problems.length)
    core.warning(
      "Dependency report contains incomplete checks; see the PR comment.",
    );
}

module.exports = { dependencies, row, report };
