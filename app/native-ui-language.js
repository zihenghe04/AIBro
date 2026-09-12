const fs = require('node:fs');
const path = require('node:path');
const { isTrustedCredentialSender } = require('./native-api-credentials');

function createNativeLanguage({ app, Menu, directory, platform, getWindow, getLocalOrigin, getNativeTheme }) {
  const filename = path.join(directory, 'ui-language.json');
  let locale = 'zh-CN';
  let appearance = 'system';
  try { const saved = JSON.parse(fs.readFileSync(filename, 'utf8')); if (saved.language === 'en') locale = 'en'; if (['light', 'dark'].includes(saved.appearance)) appearance = saved.appearance; } catch (_) {}
  const text = (zh, en) => locale === 'en' ? en : zh;
  function apply() {
    if (getNativeTheme) getNativeTheme().themeSource = appearance;
    const labels = locale === 'en' ? {
      fileMenu: 'File', editMenu: 'Edit', viewMenu: 'View', windowMenu: 'Window'
    } : { fileMenu: '文件', editMenu: '编辑', viewMenu: '视图', windowMenu: '窗口' };
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(platform === 'darwin' ? [{ label: 'AI Bro', submenu: [
        { label: text('关于 AI Bro', 'About AI Bro'), click: () => app.showAboutPanel() },
        { type: 'separator' }, { role: 'services' }, { type: 'separator' },
        { role: 'hide', label: text('隐藏 AI Bro', 'Hide AI Bro') }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit', label: text('退出 AI Bro', 'Quit AI Bro') }
      ] }] : []),
      ...Object.entries(labels).map(([role, label]) => ({ role, label }))
    ]));
  }
  function setLanguage(event, next) {
    if (!isTrustedCredentialSender(event, getWindow()?.webContents, getLocalOrigin())) throw new Error('Invalid language preference sender');
    if (!['en', 'zh-CN'].includes(next)) throw new Error('Unsupported interface language');
    if (locale !== next) {
      fs.mkdirSync(directory, { recursive: true });
      const temporary = filename + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify({ language: next, appearance }), { mode: 0o600 });
      fs.renameSync(temporary, filename);
      locale = next;
      apply();
    }
    return { language: locale };
  }
  function setAppearance(event, next) {
    if (!isTrustedCredentialSender(event, getWindow()?.webContents, getLocalOrigin())) throw new Error('Invalid appearance preference sender');
    if (!['light', 'dark'].includes(next)) throw new Error('Unsupported appearance');
    if (appearance !== next) {
      fs.mkdirSync(directory, { recursive: true });
      const temporary = filename + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify({ language: locale, appearance: next }), { mode: 0o600 });
      fs.renameSync(temporary, filename);
      appearance = next;
      if (getNativeTheme) getNativeTheme().themeSource = appearance;
    }
    return { appearance };
  }
  return { apply, setLanguage, setAppearance, text, get language() { return locale; } };
}
module.exports = { createNativeLanguage };
