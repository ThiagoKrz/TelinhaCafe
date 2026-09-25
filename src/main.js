const { app, BrowserWindow, ipcMain, desktopCapturer, session, clipboard, shell, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

// Os dados do app (nome, foto, chaves de host) ficam sempre em %APPDATA%\Telinha, mesmo com o
// produto agora chamado "Telinha Café": assim quem atualiza não perde nada.
// TELINHA_PROFILE cria um perfil separado (ex.: duas instâncias na mesma máquina pra testar).
app.setPath('userData', path.join(app.getPath('appData'),
  process.env.TELINHA_PROFILE ? 'Telinha-' + process.env.TELINHA_PROFILE.replace(/[^\w-]/g, '') : 'Telinha'));

let win = null;
let overlayWin = null;       // camada transparente com os ponteiros dos amigos, por cima da tela compartilhada
let pendingShare = null;     // { id, audio } escolhido no seletor, usado pelo getDisplayMedia
let audioProc = null;

function nativePath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, '..', 'native', name);
}
const helperPath = () => nativePath('AudioCap.exe');

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#2A2320',
    title: 'Telinha Café',
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
    stopControl();
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
  stopControl();
  app.quit();
});

app.on('will-quit', () => globalShortcut.unregisterAll());

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
  // Esconde as janelas do próprio app (principal e camada de ponteiros). Compara só o HWND:
  // o sufixo do ID pode variar entre getMediaSourceId() e o desktopCapturer.
  const hwndOf = (id) => String(id).split(':')[1];
  const hidden = new Set([win, overlayWin].filter((w) => w && !w.isDestroyed()).map((w) => hwndOf(w.getMediaSourceId())));
  return sources
    .filter((s) => !(s.id.startsWith('window:') && (hidden.has(hwndOf(s.id)) || s.name === 'Telinha · ponteiros')))
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
  overlaySource = null;
}

// Monitor correspondente a uma fonte "screen:..." do desktopCapturer.
async function displayFor(sourceId) {
  if (!String(sourceId).startsWith('screen:')) return null;
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const src = sources.find((s) => s.id === sourceId);
  const displays = screen.getAllDisplays();
  return (src && displays.find((d) => String(d.id) === String(src.display_id))) || (displays.length === 1 ? displays[0] : null);
}

// Mostra a camada por cima do monitor que está sendo compartilhado.
let overlaySource = null;
ipcMain.handle('overlay-show', async (_e, sourceId) => {
  if (overlayWin && !overlayWin.isDestroyed() && overlaySource === sourceId) return true;
  hideOverlay();
  const display = await displayFor(sourceId);
  if (!display) return false;
  overlaySource = sourceId;

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

/* ------------------------------------------------------------ controle remoto (consentido) */

// Quem compartilha aceita o pedido; aí os movimentos de quem controla chegam aqui (normalizados 0..1
// sobre o monitor compartilhado) e o InputCtl.exe os aplica no Windows.
let control = null; // { proc, rect: {x,y,width,height} em pixels físicos }
const fakeInput = !!process.env.TELINHA_FAKE_INPUT; // testes: registra em vez de mexer no mouse de verdade
global.__inputLog = [];

function controlWrite(line) {
  if (!control) return;
  if (fakeInput) { global.__inputLog.push(line); return; }
  try { control.proc.stdin.write(line + '\n'); } catch {}
}

function stopControl() {
  globalShortcut.unregister('Control+Alt+X');
  if (!control) return;
  controlWrite('reset');
  if (control.proc) {
    try { control.proc.stdin.end(); } catch {}
    const p = control.proc;
    setTimeout(() => { try { p.kill(); } catch {} }, 500);
  }
  control = null;
}

ipcMain.handle('control-start', async (_e, sourceId) => {
  stopControl();
  const display = await displayFor(sourceId);
  if (!display) return { ok: false, error: 'O controle só funciona compartilhando a tela inteira.' };
  const rect = screen.dipToScreenRect(null, display.bounds);
  let proc = null;
  if (!fakeInput) {
    const exe = nativePath('InputCtl.exe');
    if (!fs.existsSync(exe)) return { ok: false, error: 'InputCtl.exe não encontrado' };
    proc = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    proc.on('exit', () => { if (control && control.proc === proc) { control = null; sendToRenderer('control-ended', {}); } });
  }
  control = { proc, rect };
  // Atalho de emergência: corta o controle de qualquer lugar (inclusive dentro do jogo).
  globalShortcut.register('Control+Alt+X', () => sendToRenderer('control-shortcut', 'revoke'));
  return { ok: true };
});

// Chega em alta frequência: fire-and-forget.
ipcMain.on('control-input', (_e, ev) => {
  if (!control || !ev) return;
  const r = control.rect;
  switch (ev.k) {
    case 'm': {
      const x = Number(ev.x), y = Number(ev.y);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return;
      controlWrite(`m ${Math.round(r.x + x * (r.width - 1))} ${Math.round(r.y + y * (r.height - 1))}`);
      break;
    }
    case 'd':
    case 'u':
      if ([0, 1, 2].includes(ev.b)) controlWrite(`${ev.k} ${ev.b}`);
      break;
    case 'w':
      if (Number.isFinite(ev.d)) controlWrite(`w ${Math.max(-1200, Math.min(1200, Math.round(ev.d)))}`);
      break;
    case 'kd':
    case 'ku':
      if (Number.isInteger(ev.sc) && ev.sc > 0 && ev.sc < 0x80) controlWrite(`${ev.k} ${ev.sc} ${ev.ext ? 1 : 0}`);
      break;
    case 'reset':
      controlWrite('reset');
      break;
  }
});

ipcMain.handle('control-stop', () => {
  stopControl();
  return true;
});

// Pedido de controle pendente: atalhos pra aceitar/recusar sem sair do jogo, e a barra de tarefas pisca.
ipcMain.handle('control-pending', (_e, on) => {
  globalShortcut.unregister('Control+Alt+Y');
  globalShortcut.unregister('Control+Alt+N');
  if (on) {
    globalShortcut.register('Control+Alt+Y', () => sendToRenderer('control-shortcut', 'accept'));
    globalShortcut.register('Control+Alt+N', () => sendToRenderer('control-shortcut', 'deny'));
    if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
  } else if (win && !win.isDestroyed()) {
    win.flashFrame(false);
  }
  return true;
});
