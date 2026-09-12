const path = require('node:path');
const { validateAssets } = require('../app/app-assets');
const { build } = require('../package.json');

module.exports = {
  ...build,
  appId: 'app.ai-workstation.studio',
  productName: 'AI Bro',
  directories: { app: 'app', output: 'dist' },
  mac: { ...build.mac, icon: 'app/ai-bro-icon.icns' },
  asar: false,
  files: validateAssets(path.resolve(__dirname, '../app')).files,
};
