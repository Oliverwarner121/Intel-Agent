const WORKFLOW = 'validate-and-deploy.yml';

async function verifyDevelopmentRelease({ github, repository, runId }) {
  if (typeof runId !== 'string' || !/^[1-9]\d*$/.test(runId)) {
    throw new Error('A positive development workflow run ID is required.');
  }
  const id = Number(runId);
  if (!Number.isSafeInteger(id)) {
    throw new Error('Development run ID is outside the supported range.');
  }

  const { data: workflow } = await github.rest.actions.getWorkflow({
    ...repository,
    workflow_id: WORKFLOW,
  });
  const { data: run } = await github.rest.actions.getWorkflowRun({
    ...repository,
    run_id: id,
  });
  if (
    run.workflow_id !== workflow.id ||
    run.head_branch !== 'main' ||
    !['push', 'workflow_dispatch'].includes(run.event) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    !/^[a-f0-9]{40}$/.test(run.head_sha)
  ) {
    throw new Error('Select a completed successful main run of Validate and deploy.');
  }

  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repository,
    run_id: id,
    filter: 'latest',
    per_page: 100,
  });
  if (!jobs.some((job) => job.name === 'Deploy development' && job.conclusion === 'success')) {
    throw new Error('The selected run did not successfully deploy development.');
  }
  return run.head_sha;
}

module.exports = { verifyDevelopmentRelease };
