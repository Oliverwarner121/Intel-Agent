const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { dependencies, row, report } = require("./dependency-report.cjs");

test("reads direct and dev dependencies from installed lockfile versions", () => {
  assert.deepEqual(
    dependencies(
      {
        private: true,
        dependencies: { example: "^1.0.0" },
        devDependencies: { tool: "~2.0.0" },
      },
      {
        packages: {
          "node_modules/example": { version: "1.2.0" },
          "node_modules/tool": { version: "2.0.1" },
        },
      },
    ),
    [
      { name: "tool", range: "~2.0.0", installed: "2.0.1" },
      { name: "example", range: "^1.0.0", installed: "1.2.0" },
    ],
  );
});

test("rejects non-registry dependencies, untrusted package names and non-private manifests", () => {
  for (const [name, range] of [
    ["bad|name", "1.0.0"],
    ["example", "git+https://example.com"],
  ]) {
    assert.throws(() =>
      dependencies({ private: true, dependencies: { [name]: range } }, {}),
    );
  }
  assert.throws(() => dependencies({ dependencies: { example: "1.0.0" } }, {}));
});

test("does not label advisory failures or known vulnerabilities safe", () => {
  assert.match(
    row("root", "example", "1.0.0", "2.0.0", null),
    /unavailable/,
  );
  assert.match(
    row("root", "example", "1.0.0", "2.0.0", 1),
    /do not upgrade blindly/,
  );
  assert.match(
    row("root", "example", "1.0.0", "2.0.0", 0),
    /test compatibility/,
  );
});

async function fixture({
  existing = false,
  lookupFailure = false,
  advisoryFailure = false,
  advisory = false,
  latest = "2.0.0",
  missing = false,
  notScaffolded = false,
} = {}) {
  const writes = [];
  const warnings = [];
  const marker = "<!-- intel-agent-dependency-report -->";
  const listComments = () => {};
  const listAdvisories = () => {};
  const github = {
    rest: {
      repos: {
        getContent: async ({ path, ref }) => {
          assert.equal(ref, "abc123");
          if (notScaffolded) {
            throw Object.assign(new Error("Not Found"), { status: 404 });
          }
          if (missing) throw new Error("Missing file");
          const data = path.endsWith("package-lock.json")
            ? { packages: { "node_modules/example": { version: "1.0.0" } } }
            : { private: true, dependencies: { example: "^1.0.0" } };
          return {
            data: {
              type: "file",
              encoding: "base64",
              size: 100,
              content: Buffer.from(JSON.stringify(data)).toString("base64"),
            },
          };
        },
      },
      securityAdvisories: { listGlobalAdvisories: listAdvisories },
      issues: {
        listComments,
        createComment: async (input) =>
          writes.push({ type: "create", ...input }),
        updateComment: async (input) =>
          writes.push({ type: "update", ...input }),
      },
    },
    paginate: async (method) => {
      if (method === listComments) {
        const spoof = { id: 10, user: { login: "attacker" }, body: marker };
        return existing
          ? [
              spoof,
              { id: 20, user: { login: "github-actions[bot]" }, body: marker },
            ]
          : [spoof];
      }
      if (advisoryFailure) throw new Error("Advisory API unavailable");
      return advisory ? [{ withdrawn_at: null }] : [];
    },
  };
  await report({
    github,
    context: {
      repo: { owner: "owner", repo: "repo" },
      payload: { pull_request: { number: 1, head: { sha: "abc123" } } },
    },
    core: { warning: (message) => warnings.push(message) },
    fetchPackage: async (name) => {
      if (lookupFailure) throw new Error("Registry unavailable");
      return { name, version: latest };
    },
  });
  return { writes, warnings };
}

test("posts an informational report and updates only its existing bot comment", async () => {
  const created = await fixture();
  assert.equal(created.writes.length, 1);
  assert.equal(created.writes[0].type, "create");
  assert.match(created.writes[0].body, /example/);
  assert.match(created.writes[0].body, /2\.0\.0/);
  const updated = await fixture({ existing: true });
  assert.equal(updated.writes[0].type, "update");
  assert.equal(updated.writes[0].comment_id, 20);
});

test("reports incomplete registry, advisory and manifest checks explicitly", async () => {
  for (const options of [
    { lookupFailure: true },
    { advisoryFailure: true },
    { missing: true },
    { latest: "2.0.0-beta.1" },
  ]) {
    const result = await fixture(options);
    assert.equal(result.warnings.length, 1);
    assert.match(result.writes[0].body, /Incomplete checks/);
  }
});

test("known vulnerable latest versions are not recommended", async () => {
  const result = await fixture({ advisory: true });
  assert.match(
    result.writes[0].body,
    /known advisories; do not upgrade blindly/,
  );
});

test("up-to-date packages and older latest tags do not produce update rows", async () => {
  for (const latest of ["1.0.0", "0.9.0"]) {
    const result = await fixture({ latest });
    assert.match(result.writes[0].body, /No newer stable versions/);
    assert.doesNotMatch(result.writes[0].body, /\| root \|/);
  }
});

test("treats a missing package.json as not yet scaffolded without warnings", async () => {
  const result = await fixture({ notScaffolded: true });
  assert.equal(result.warnings.length, 0);
  assert.match(result.writes[0].body, /has not been scaffolded/);
  assert.doesNotMatch(result.writes[0].body, /Incomplete checks/);
});

test("report workflow only runs trusted base-branch code with minimal permissions", () => {
  const workflow = readFileSync(
    path.join(__dirname, "../workflows/dependency-report.yml"),
    "utf8",
  );
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /^permissions:\n  contents: read\n  pull-requests: write$/m);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.doesNotMatch(workflow, /pull_request\.head\.(?:sha|ref)/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /continue-on-error: true/);
  assert.doesNotMatch(workflow, /npm (?:ci|install)|run: /);
});
