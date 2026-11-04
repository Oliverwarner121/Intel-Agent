const assert = require('node:assert/strict');
const { test } = require('node:test');
const { verifyDevelopmentRelease } = require('./verify-development-release.cjs');
const { prepareDeployment } = require('./prepare-deployment.cjs');

const sha = 'a'.repeat(40);
const repository = { owner: 'example', repo: 'intel-agent' };

function fixture(overrides = {}, jobs = [{ name: 'Deploy development', conclusion: 'success' }]) {
  const run = {
    workflow_id: 7,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_sha: sha,
    ...overrides,
  };
  return {
    rest: {
      actions: {
        getWorkflow: async (request) => {
          assert.equal(request.workflow_id, 'validate-and-deploy.yml');
          return { data: { id: 7 } };
        },
        getWorkflowRun: async (request) => {
          assert.equal(request.owner, repository.owner);
          assert.equal(request.repo, repository.repo);
          assert.equal(request.run_id, 123);
          return { data: run };
        },
        listJobsForWorkflowRun: () => {},
      },
    },
    paginate: async (_method, request) => {
      assert.equal(request.filter, 'latest');
      return jobs;
    },
  };
}

test('promotes the exact successful dev source commit', async () => {
  assert.equal(await verifyDevelopmentRelease({ github: fixture(), repository, runId: '123' }), sha);
});

test('accepts a manually deployed development run', async () => {
  assert.equal(await verifyDevelopmentRelease({
    github: fixture({ event: 'workflow_dispatch' }), repository, runId: '123',
  }), sha);
});

test('rejects invalid run IDs before calling GitHub', async () => {
  for (const runId of ['', '0', '-1', '1.2', '123\n', '9007199254740992', undefined]) {
    await assert.rejects(verifyDevelopmentRelease({ github: {}, repository, runId }), /run ID/i);
  }
});

test('rejects wrong workflows, branches, events, unfinished and failed runs', async () => {
  for (const override of [
    { workflow_id: 8 }, { head_branch: 'feature' }, { event: 'pull_request' },
    { status: 'in_progress' }, { conclusion: 'failure' }, { head_sha: 'invalid' },
  ]) {
    await assert.rejects(verifyDevelopmentRelease({
      github: fixture(override), repository, runId: '123',
    }), /successful main run/);
  }
});

test('rejects skipped dev, failed dev, repository-only and production runs', async () => {
  for (const jobs of [
    [], [{ name: 'Deploy development', conclusion: 'skipped' }],
    [{ name: 'Deploy development', conclusion: 'failure' }],
    [{ name: 'Deploy production', conclusion: 'success' }],
  ]) {
    await assert.rejects(verifyDevelopmentRelease({
      github: fixture({}, jobs), repository, runId: '123',
    }), /did not successfully deploy development/);
  }
});

test('GitHub API failures remain explicit', async () => {
  const github = fixture();
  github.rest.actions.getWorkflowRun = async () => { throw new Error('API unavailable'); };
  await assert.rejects(verifyDevelopmentRelease({ github, repository, runId: '123' }), /API unavailable/);
});

test('dev removes Cron without mutating source configuration', () => {
  const config = { crons: [{ path: '/api/cron/morning-briefing', schedule: '0 5 * * *' }], git: { deploymentEnabled: true } };
  assert.deepEqual(prepareDeployment(config, 'dev'), { git: { deploymentEnabled: false } });
  assert.equal(config.crons.length, 1);
  assert.equal(config.git.deploymentEnabled, true);
});

test('prod preserves Cron and unrelated configuration, disabling automatic Git deploys', () => {
  const config = { crons: [{ path: '/api/cron/morning-briefing', schedule: '0 5 * * *' }], regions: ['lhr1'] };
  assert.deepEqual(prepareDeployment(config, 'prod'), { ...config, git: { deploymentEnabled: false } });
});

test('invalid deployment targets and configuration fail', () => {
  assert.throws(() => prepareDeployment({}, 'preview'), /target/);
  for (const config of [null, [], 'invalid']) {
    assert.throws(() => prepareDeployment(config, 'dev'), /object/);
  }
});
