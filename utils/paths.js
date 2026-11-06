const path = require('path');
const { app } = require('electron');

const baseUserDir = app.getPath('userData');
// Factory assets are shipped once, outside ASAR. Runtime/user files stay in
// userData; development continues to use the repository's asset folders.
const bundledAssetsDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');

module.exports = {
  defaultSoundsFolder: path.join(bundledAssetsDir, 'sounds'),
  defaultPresetsFolder: path.join(bundledAssetsDir, 'presets'),
  defaultThemesFolder: path.join(__dirname, '..', 'assets', 'themes'),
  userSoundsFolder: path.join(baseUserDir, 'sounds'),
  userPresetsFolder: path.join(baseUserDir, 'presets'),
  userThemesFolder: path.join(baseUserDir, 'Themes'),
  preferencesPath: path.join(baseUserDir, 'preferences.json'),
  configsDir: path.join(baseUserDir, 'configs'),
  cacheDir: path.join(baseUserDir, 'ach_cache')
};
