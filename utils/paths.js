const path = require('path');
const { app } = require('electron');

const baseUserDir = app.getPath('userData');

module.exports = {
  defaultSoundsFolder: path.join(__dirname, '..', 'sounds'),
  defaultPresetsFolder: path.join(__dirname, '..', 'presets'),
  defaultThemesFolder: path.join(__dirname, '..', 'assets', 'themes'),
  userSoundsFolder: path.join(baseUserDir, 'sounds'),
  userPresetsFolder: path.join(baseUserDir, 'presets'),
  userThemesFolder: path.join(baseUserDir, 'Themes'),
  preferencesPath: path.join(baseUserDir, 'preferences.json'),
  configsDir: path.join(baseUserDir, 'configs'),
  cacheDir: path.join(baseUserDir, 'ach_cache')
};
