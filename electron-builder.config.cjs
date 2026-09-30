/** Windows build ships its runtime; no model credentials or user data are copied. */
module.exports = {
  appId: 'cn.franklil.qianwenchat',
  productName: 'QianwenChat',
  executableName: 'QianwenChat',
  artifactName: 'QianwenChat-Setup-${version}-${arch}.${ext}',
  directories: { output: 'release', buildResources: 'desktop-assets' },
  electronDist: 'node_modules/electron/dist',
  files: ['dist/**/*', 'desktop-dist/**/*', 'package.json', '!**/*.map', '!**/.env*', '!**/.local/**'],
  asar: true,
  // The parser uses Electron in Node mode and needs real files/native bindings.
  asarUnpack: ['desktop-dist/server/document-worker.mjs', 'node_modules/**/*'],
  npmRebuild: false,
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'desktop-dist/icon.ico', requestedExecutionLevel: 'asInvoker' },
  nsis: {
    oneClick: true, perMachine: false, deleteAppDataOnUninstall: false,
    createDesktopShortcut: true, createStartMenuShortcut: true,
    shortcutName: '千问桌面助手', uninstallDisplayName: '千问桌面助手',
    runAfterFinish: false, installerIcon: 'desktop-dist/icon.ico', uninstallerIcon: 'desktop-dist/icon.ico',
  },
  publish: null,
};
