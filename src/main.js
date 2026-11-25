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
let pendingDeepLink = null;

function extractRoomCodeFromArgs(argv) {
  for (const arg of argv || []) {
    const m = /^telinha:\/\/([A-Z0-9]{6})\/?$/i.exec(String(arg || '').trim());
    if (m) return m[1].toUpperCase();
  }
  return null;
}

if (!process.env.TELINHA_PROFILE) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', (_e, argv) => {
      const code = extractRoomCodeFromArgs(argv);
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
        if (code) sendToRenderer('deep-link', code);
      } else if (code) {
        pendingDeepLink = code;
      }
    });
  }
}
pendingDeepLink = extractRoomCodeFromArgs(process.argv);

function winStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const st = JSON.parse(fs.readFileSync(winStatePath(), 'utf8'));
    if (!st || typeof st.width !== 'number' || typeof st.height !== 'number') return null;
    const width = Math.max(900, Math.min(3840, Math.round(st.width)));
    const height = Math.max(600, Math.min(2160, Math.round(st.height)));
    const displays = screen.getAllDisplays();
    const visible = typeof st.x === 'number' && typeof st.y === 'number' && displays.some((d) => {
      const b = d.workArea;
      return st.x + width > b.x + 80 && st.x < b.x + b.width - 80 && st.y + height > b.y + 80 && st.y < b.y + b.height - 80;
    });
    return {
      width,
      height,
      x: visible ? Math.round(st.x) : undefined,
      y: visible ? Math.round(st.y) : undefined,
      maximized: !!st.maximized,
    };
  } catch {
    return null;
  }
}

function saveWindowState(w) {
  if (!w || w.isDestroyed()) return;
  try {
    const maximized = w.isMaximized();
    const bounds = maximized ? w.getNormalBounds() : w.getBounds();
    fs.writeFileSync(winStatePath(), JSON.stringify({ ...bounds, maximized }));
  } catch {}
}

function nativePath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, '..', 'native', name);
}
const helperPath = () => nativePath('AudioCap.exe');

function createWindow() {
  const saved = loadWindowState();
  win = new BrowserWindow({
    width: saved ? saved.width : 1280,
    height: saved ? saved.height : 800,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
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
  if (saved && saved.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    if (pendingDeepLink) {
      sendToRenderer('deep-link', pendingDeepLink);
      pendingDeepLink = null;
    }
  });
  let saveTimer = null;
  const queueSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 400);
  };
  win.on('resize', queueSave);
  win.on('move', queueSave);
  win.on('close', () => saveWindowState(win));

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
  try {
    if (app.isPackaged) app.setAsDefaultProtocolClient('telinha');
  } catch {}
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

ipcMain.handle('read-clipboard', () => {
  try { return clipboard.readText() || ''; } catch { return ''; }
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

/* ------------------------------------------------------------ atualizações (GitHub Releases) */

const GITHUB_RELEASE_API = 'https://api.github.com/repos/ThiagoKrz/TelinhaCafe/releases/latest';

function cmpSemver(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map(Number);
  const pb = String(b || '').replace(/^v/i, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

ipcMain.handle('check-update', async () => {
  const current = app.getVersion();
  const portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(GITHUB_RELEASE_API, {
      signal: ctrl.signal,
      headers: { 'User-Agent': `TelinhaCafe/${current}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, current };
    const data = await res.json();
    const latest = String(data.tag_name || '').replace(/^v/i, '');
    const hasUpdate = latest && cmpSemver(latest, current) > 0;
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const wanted = portable
      ? assets.find((a) => /portatil\.exe$/i.test(a.name || ''))
      : assets.find((a) => /Setup.*\.exe$/i.test(a.name || ''));
    return {
      ok: true,
      hasUpdate,
      current,
      latest: latest || current,
      releaseUrl: data.html_url || 'https://github.com/ThiagoKrz/TelinhaCafe/releases/latest',
      downloadUrl: wanted ? wanted.browser_download_url : null,
      assetName: wanted ? wanted.name : null,
      canAutoInstall: !portable && !!(wanted && wanted.browser_download_url),
    };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'falhou', current };
  } finally {
    clearTimeout(timer);
  }
});

let updating = false;
ipcMain.handle('install-update', async (_e, { downloadUrl, assetName, releaseUrl } = {}) => {
  if (updating) return { ok: false, error: 'Atualização já em andamento.' };
  const portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  if (portable || !downloadUrl || !/^https:\/\/github\.com\/ThiagoKrz\/TelinhaCafe\//i.test(downloadUrl)) {
    const target = downloadUrl || releaseUrl || 'https://github.com/ThiagoKrz/TelinhaCafe/releases/latest';
    if (/^https:\/\//i.test(target)) shell.openExternal(target);
    return { ok: true, openedBrowser: true };
  }

  updating = true;
  const safeName = String(assetName || 'TelinhaCafe-Setup-update.exe').replace(/[^a-zA-Z0-9._-]/g, '');
  const dest = path.join(app.getPath('temp'), safeName);
  try {
    sendToRenderer('update-progress', { pct: 0, phase: 'downloading' });
    const res = await fetch(downloadUrl, { headers: { 'User-Agent': `TelinhaCafe/${app.getVersion()}` } });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') || 0);
    let received = 0;
    const out = fs.createWriteStream(dest);
    const reader = res.body.getReader();
    let lastPct = -1;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(Buffer.from(value));
      received += value.byteLength;
      if (total > 0) {
        const pct = Math.min(100, Math.round((received / total) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          sendToRenderer('update-progress', { pct, received, total, phase: 'downloading' });
        }
      }
    }
    await new Promise((r, rej) => { out.end(r); out.on('error', rej); });
    const stat = fs.statSync(dest);
    if (stat.size < 1024 * 1024) throw new Error('Arquivo baixado parece incompleto.');
    sendToRenderer('update-progress', { pct: 100, phase: 'installing' });
    stopAudio();
    stopControl();
    hideOverlay();
    spawn(dest, [], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 350);
    return { ok: true };
  } catch (e) {
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}
    return { ok: false, error: (e && e.message) || 'Falha ao baixar atualização.' };
  } finally {
    updating = false;
  }
});
