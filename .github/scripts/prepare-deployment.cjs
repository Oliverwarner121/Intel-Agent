const fs = require('node:fs');

function prepareDeployment(config, target) {
  if (!['dev', 'prod'].includes(target)) {
    throw new Error('Deployment target must be dev or prod.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Vercel configuration must be an object.');
  }
  const prepared = { ...config, git: { ...config.git, deploymentEnabled: false } };
  if (target === 'dev') {
    delete prepared.crons;
  }
  return prepared;
}

if (require.main === module) {
  const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
  fs.writeFileSync('vercel.json', `${JSON.stringify(prepareDeployment(config, process.argv[2]), null, 2)}\n`);
}

module.exports = { prepareDeployment };
