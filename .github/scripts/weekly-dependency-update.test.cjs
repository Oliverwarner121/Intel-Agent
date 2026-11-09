"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const {
  actionPins,
  planNpm,
  replaceActionPin,
  summary,
  updateType,
} = require("./weekly-dependency-update.cjs");

const sha = (character) => character.repeat(40);
const workflow = readFileSync(
  path.join(__dirname, "../workflows/weekly-dependency-updates.yml"),
  "utf8",
);
const deployWorkflow = readFileSync(
  path.join(__dirname, "../workflows/validate-and-deploy.yml"),
  "utf8",
);

test("classifies update types", () => {
  assert.equal(updateType("1.2.3", "1.2.4"), "patch");
  assert.equal(updateType("1.2.3", "1.3.0"), "minor");
  assert.equal(updateType("v1.2.3", "v2.0.0"), "major");
});

test("plans npm updates, preserves specifier style and holds listed majors", () => {
  const manifest = {
    dependencies: {
      exact: "1.0.0",
      caret: "^2.0.0",
      range: ">=1.0.0",
      current: "3.0.0",
    },
    devDependencies: { "@types/node": "^24.1.0" },
  };
  const lock = {
    packages: {
      "node_modules/exact": { version: "1.0.0" },
      "node_modules/caret": { version: "2.1.0" },
      "node_modules/range": { version: "1.0.0" },
      "node_modules/current": { version: "3.0.0" },
      "node_modules/@types/node": { version: "24.1.0" },
    },
  };
  const latest = new Map([
    ["exact", "1.1.0"],
    ["caret", "3.0.0"],
    ["range", "2.0.0"],
    ["current", "3.0.0"],
    ["@types/node", "25.0.0"],
  ]);

  const plan = planNpm(manifest, lock, latest);

  assert.deepEqual(
    plan.updates.map(({ name, specifier, type }) => ({ name, specifier, type })),
    [
      { name: "exact", specifier: "1.1.0", type: "minor" },
      { name: "caret", specifier: "^3.0.0", type: "major" },
    ],
  );
  assert.deepEqual(
    plan.held.map(({ name, available }) => ({ name, available })),
    [{ name: "@types/node", available: "25.0.0" }],
  );
});

test("allows held packages to receive current-major updates", () => {
  const plan = planNpm(
    { devDependencies: { "@types/node": "^24.1.0" } },
    { packages: { "node_modules/@types/node": { version: "24.1.0" } } },
    new Map([["@types/node", "24.2.0"]]),
  );
  assert.deepEqual(plan.held, []);
  assert.equal(plan.updates[0].specifier, "^24.2.0");
});

test("holds TypeScript 7 until lint tooling supports it", () => {
  const plan = planNpm(
    { devDependencies: { typescript: "^6.0.3" } },
    { packages: { "node_modules/typescript": { version: "6.0.3" } } },
    new Map([["typescript", "7.0.2"]]),
  );
  assert.deepEqual(plan.updates, []);
  assert.equal(plan.held.length, 1);
  assert.equal(plan.held[0].name, "typescript");
  assert.match(plan.held[0].reason, /typescript-eslint/);
});

test("allows TypeScript 6 patch updates", () => {
  const plan = planNpm(
    { devDependencies: { typescript: "^6.0.3" } },
    { packages: { "node_modules/typescript": { version: "6.0.3" } } },
    new Map([["typescript", "6.0.4"]]),
  );
  assert.deepEqual(plan.held, []);
  assert.equal(plan.updates[0].specifier, "^6.0.4");
});

test("ignores prerelease registry versions and missing lock entries", () => {
  assert.deepEqual(
    planNpm(
      { dependencies: { next: "16.0.0" } },
      { packages: { "node_modules/next": { version: "16.0.0" } } },
      new Map([["next", "17.0.0-canary.1"]]),
    ).updates,
    [],
  );
  assert.deepEqual(
    planNpm({ dependencies: { next: "16.0.0" } }, {}, new Map([["next", "16.1.0"]])).updates,
    [],
  );
});

test("finds and replaces SHA-pinned actions, including sub-paths", () => {
  const source = [
    `      - uses: actions/checkout@${sha("a")} # v7.0.1`,
    `      - uses: github/codeql-action/init@${sha("b")} # v4.1.0`,
    "      - uses: ./local-action",
  ].join("\n");

  const pins = actionPins(source);
  assert.deepEqual(
    pins.map(({ repository, subpath, tag }) => ({ repository, subpath, tag })),
    [
      { repository: "actions/checkout", subpath: "", tag: "v7.0.1" },
      { repository: "github/codeql-action", subpath: "/init", tag: "v4.1.0" },
    ],
  );

  const updated = replaceActionPin(source, pins[0], sha("c"), "v7.1.0");
  assert.match(updated, new RegExp(`actions/checkout@${sha("c")} # v7\\.1\\.0`));
  assert.match(updated, new RegExp(`codeql-action/init@${sha("b")} # v4\\.1\\.0`));
});

test("summarises applied, held and failed updates", () => {
  const body = summary({
    date: "2026-11-02",
    applied: [{ area: "root", name: "next", from: "16.0.0", to: "16.1.0", type: "minor" }],
    held: [{
      area: "root", name: "@types/node", installed: "24.1.0", available: "25.0.0",
      reason: "Types must match the Node 24 LTS runtime.",
    }],
    failed: [{ area: "root", name: "eslint", to: "11.0.0", error: "ERESOLVE a | b" }],
    majorActions: [],
    audits: [{ area: "root", counts: { critical: 0, high: 0, moderate: 1, low: 0 } }],
    problems: [],
  });

  assert.match(body, /\| root \| `next` \| 16\.0\.0 \| 16\.1\.0 \| minor \|/);
  assert.match(body, /### Held back/);
  assert.match(body, /ERESOLVE a \\\| b/);
  assert.match(body, /\| root \| 0 \| 0 \| 1 \| 0 \|/);
  assert.doesNotMatch(body, /### Problems/);
});

test("reports a missing application manifest as a problem without an audit table", () => {
  const body = summary({
    date: "2026-11-02",
    applied: [], held: [], failed: [], majorActions: [], audits: [],
    problems: ["root: no package.json yet; npm updates skipped until the application is scaffolded."],
  });
  assert.match(body, /### Problems/);
  assert.doesNotMatch(body, /### Production security audit/);
});

test("lists action pins to update by hand when workflow edits are not allowed", () => {
  const body = summary({
    date: "2026-11-02",
    applied: [], held: [], failed: [], majorActions: [],
    manualActions: [{ name: "actions/checkout", from: "v7.0.1", to: "v7.1.0", sha: sha("d") }],
    audits: [], problems: [],
  });
  assert.match(body, /### GitHub Actions updates to apply by hand/);
  assert.match(body, new RegExp(`\`${sha("d")} # v7\\.1\\.0\``));
});

test("weekly workflow runs Monday morning without persisted credentials", () => {
  assert.match(workflow, /cron: "0 5 \* \* 1"/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /gh workflow run validate-and-deploy\.yml --ref "\$BRANCH"/);
});

test("weekly workflow creates or refreshes a PR but leaves approval and merging to a human", () => {
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /gh pr create --base main --head "\$BRANCH"/);
  assert.match(workflow, /gh api -X PATCH "repos\/\$GITHUB_REPOSITORY\/pulls\/\$number"/);
  assert.doesNotMatch(workflow, /gh pr (?:merge|review)\b/);
  assert.doesNotMatch(
    workflow,
    /enablePullRequestAutoMerge|mergePullRequest|\/pulls\/[^"\s]+\/(?:merge|reviews)\b/,
  );
});

test("dispatching validation on the update branch cannot deploy", () => {
  assert.doesNotMatch(deployWorkflow, /Run deployment workflows from main/);
  assert.match(
    deployWorkflow,
    /resolve-release:[\s\S]*?if: [^\n]*github\.ref == 'refs\/heads\/main'/,
  );
});
