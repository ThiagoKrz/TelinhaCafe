const { app, BrowserWindow, ipcMain, desktopCapturer, session, clipboard, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

// Perfil separado (ex.: rodar duas instâncias na mesma máquina pra testar).
if (process.env.TELINHA_PROFILE) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Telinha-' + process.env.TELINHA_PROFILE.replace(/[^\w-]/g, '')));
}

let win = null;
let overlayWin = null;       // camada transparente com os ponteiros dos amigos, por cima da tela compartilhada
let pendingShare = null;     // { id, audio } escolhido no seletor, usado pelo getDisplayMedia
let audioProc = null;

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'AudioCap.exe')
    : path.join(__dirname, '..', 'native', 'AudioCap.exe');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e1014',
    title: 'Telinha',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Links externos abrem no navegador padrão, nunca dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('closed', () => {
    win = null;
    stopAudio();
    hideOverlay();
  });
}

app.whenReady().then(() => {
  // getDisplayMedia no renderer cai aqui; entregamos a fonte escolhida no nosso seletor.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sel = pendingShare;
    pendingShare = null;
    try {
      if (!sel) return callback({});
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find((s) => s.id === sel.id);
      if (!source) return callback({});
      const streams = { video: source };
      if (sel.audio) streams.audio = 'loopback';
      callback(streams);
    } catch {
      callback({});
    }
  });

  createWindow();
});

app.on('window-all-closed', () => {
  stopAudio();
  app.quit();
});

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

ipcMain.handle('app-info', () => ({
  version: app.getVersion(),
  portable: !!process.env.PORTABLE_EXECUTABLE_DIR,
}));

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  const hidden = new Set([win, overlayWin].filter((w) => w && !w.isDestroyed()).map((w) => w.getMediaSourceId()));
  return sources
    .filter((s) => !hidden.has(s.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      isScreen: s.id.startsWith('screen:'),
      thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));
});

ipcMain.handle('select-source', (_e, sel) => {
  pendingShare = { id: String(sel.id), audio: !!sel.audio };
  return true;
});

ipcMain.handle('copy', (_e, text) => {
  clipboard.writeText(String(text));
  return true;
});

/* ------------------------------------------------------------ áudio (AudioCap.exe) */

// Testa se a captura de áudio por programa funciona nesta máquina.
let probeResult = null;
ipcMain.handle('probe-audio', () => {
  if (probeResult) return probeResult;
  probeResult = new Promise((resolve) => {
    const exe = helperPath();
    if (process.platform !== 'win32' || !fs.existsSync(exe)) {
      return resolve({ ok: false, error: 'Captura de áudio por programa indisponível.' });
    }
    execFile(exe, ['--probe'], { timeout: 8000, windowsHide: true }, (err, _stdout, stderr) => {
      const line = String(stderr || '').split(/\r?\n/).find((l) => /^(OK|ERROR)/.test(l)) || '';
      if (line.startsWith('OK')) resolve({ ok: true, target: line.split(' ')[1] });
      else resolve({ ok: false, error: line.replace(/^ERROR\s*/, '') || (err && err.message) || 'falhou' });
    });
  });
  return probeResult;
});

// Programas com sessão de áudio (pra opção "só o som de um app").
ipcMain.handle('list-audio-apps', () => new Promise((resolve) => {
  const exe = helperPath();
  if (!fs.existsSync(exe)) return resolve([]);
  execFile(exe, ['--list-sessions', '--self-pid', String(process.pid)], { timeout: 10000, windowsHide: true, encoding: 'utf8' }, async (_err, stdout) => {
    const apps = [];
    for (const line of String(stdout || '').split(/\r?\n/)) {
      try {
        const a = JSON.parse(line);
        let icon = null;
        if (a.exe) {
          try { icon = (await app.getFileIcon(a.exe, { size: 'small' })).toDataURL(); } catch {}
        }
        apps.push({ pid: a.pid, name: a.name, exe: path.win32.basename(a.exe || ''), active: !!a.active, icon });
      } catch {}
    }
    apps.sort((x, y) => (y.active - x.active) || x.name.localeCompare(y.name));
    resolve(apps);
  });
}));

function stopAudio() {
  if (audioProc) {
    try { audioProc.stdin.end(); } catch {}
    try { audioProc.kill(); } catch {}
    audioProc = null;
  }
}

// opts: { mode: 'nodiscord' } | { mode: 'app', pid } | { mode: 'window', sourceId: 'window:HWND:0' }
ipcMain.handle('audio-start', (_e, opts = {}) => {
  stopAudio();
  return new Promise((resolve) => {
    const exe = helperPath();
    if (!fs.existsSync(exe)) return resolve({ ok: false, error: 'AudioCap.exe não encontrado' });

    let args = ['--self-pid', String(process.pid)];
    if (opts.mode === 'app') args = ['--include-pid', String(Number(opts.pid) || 0)];
    else if (opts.mode === 'window') {
      const hwnd = /^window:(\d+):/.exec(String(opts.sourceId || ''));
      if (!hwnd) return resolve({ ok: false, error: 'Essa opção só funciona compartilhando uma janela.' });
      args = ['--include-hwnd', hwnd[1]];
    }

    const proc = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    audioProc = proc;
    let settled = false;
    const settle = (res) => { if (!settled) { settled = true; resolve(res); } };
    const timer = setTimeout(() => settle({ ok: false, error: 'O capturador de áudio não respondeu' }), 10000);

    let rest = Buffer.alloc(0);
    proc.stdout.on('data', (chunk) => {
      if (audioProc !== proc) return;
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const usable = buf.length - (buf.length % 4); // quadros inteiros (16 bits x 2 canais)
      if (usable > 0) sendToRenderer('audio-data', Buffer.from(buf.subarray(0, usable)));
      rest = Buffer.from(buf.subarray(usable));
    });

    let errBuf = '';
    proc.stderr.on('data', (d) => {
      errBuf += d.toString();
      let idx;
      while ((idx = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, idx).trim();
        errBuf = errBuf.slice(idx + 1);
        if (!line) continue;
        if (line.startsWith('OK')) { clearTimeout(timer); settle({ ok: true, target: line.split(' ')[1] }); }
        else if (line.startsWith('ERROR')) {
          clearTimeout(timer);
          if (settled && audioProc === proc) sendToRenderer('audio-status', { type: 'error', message: line.slice(6) });
          settle({ ok: false, error: line.slice(6) });
        } else if (line.startsWith('INFO')) sendToRenderer('audio-status', { type: 'target', target: line.split(' ')[1] });
      }
    });

    proc.on('error', (e) => { clearTimeout(timer); settle({ ok: false, error: e.message }); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      settle({ ok: false, error: `O capturador de áudio fechou (código ${code})` });
      if (audioProc === proc) {
        audioProc = null;
        sendToRenderer('audio-status', { type: 'exit', code });
      }
    });
  });
});

ipcMain.handle('audio-stop', () => {
  stopAudio();
  return true;
});

/* ------------------------------------------------------------ camada de ponteiros sobre a tela */

function hideOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
  overlayWin = null;
}

// Mostra a camada por cima do monitor que está sendo compartilhado.
ipcMain.handle('overlay-show', async (_e, sourceId) => {
  hideOverlay();
  if (!String(sourceId).startsWith('screen:')) return false;
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const src = sources.find((s) => s.id === sourceId);
  const displays = screen.getAllDisplays();
  const display = (src && displays.find((d) => String(d.id) === String(src.display_id))) || (displays.length === 1 ? displays[0] : null);
  if (!display) return false;

  const { x, y, width, height } = display.bounds;
  overlayWin = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  overlayWin.setIgnoreMouseEvents(true);          // cliques passam direto pro jogo/app
  // Não aparece na captura (senão os amigos veriam os ponteiros em dobro).
  // Obs.: não usar setAlwaysOnTop(true, 'screen-saver'): com esse nível o Windows ignora a proteção.
  overlayWin.setContentProtection(true);
  overlayWin.setBounds({ x, y, width, height });
  await overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  if (overlayWin) {
    overlayWin.showInactive();
    overlayWin.setContentProtection(true);
  }
  return true;
});

ipcMain.handle('overlay-hide', () => {
  hideOverlay();
  return true;
});

ipcMain.on('overlay-event', (_e, evt) => {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('annot', evt);
});
