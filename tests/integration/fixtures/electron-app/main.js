/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// The smallest Electron app the integration suite can record: one window
// on `noise.html`, which repaints a canvas with random pixels every frame
// so a real recording is orders of magnitude larger than a blank one, and
// fires one fetch so the network stream has something to capture.
//
// Launched by Playwright's `_electron.launch({ executablePath, args: [this] })`
// from a sandbox spec; the tracer under test must close it at teardown.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

if (process.env.CI) {
  // GitHub runners are unprivileged; Chromium's sandbox is the one thing
  // that varies between them and a laptop, so take it out of the picture.
  app.commandLine.appendSwitch('no-sandbox');
}

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 800, height: 600, show: true });
  win.loadFile(path.join(__dirname, 'noise.html'), {
    query: { base: process.env.INTEGRATION_BASE_URL || '' },
  });
});

app.on('window-all-closed', () => app.quit());
