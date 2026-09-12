const { validateAssets } = require('./app-assets');
const { build } = require('./package.json');

module.exports = {
  ...build,
  // Display branding may change; the existing bundle identity must not.
  appId: 'app.ai-workstation.studio',
  productName: 'AI Bro',
  mac: { ...build.mac, icon: 'ai-bro-icon.icns' },
  // Python serves these resources directly, outside Electron's ASAR reader.
  asar: false,
  files: validateAssets(__dirname).files,
};
