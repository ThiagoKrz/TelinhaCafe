'use strict';

/* =========================================================================
   Telinha Café — compartilhamento de tela/câmera P2P (WebRTC em malha via PeerJS)

   - Cada pessoa tem um ID pessoal aleatório no servidor do PeerJS e conecta
     direto em cada outra (malha).
   - O código da sala é só a "porta" (ID "telinha-sala-CODIGO", formato fixo
     entre versões). Quem segura a porta recebe quem chega e entrega a lista de
     membros; se essa pessoa sai, outra assume sozinha.
     Contrato da porta (não mudar entre versões): quem chega manda metadata
     { room, v, ... } e recebe { t:'welcome', ... } ou { t:'reject', reason, msg }.
   - O host é quem tem a chave da sala (par ECDSA guardado no PC dele). Ele
     prova isso assinando seu ID pessoal; assim pode sair e voltar como host.
   ========================================================================= */

const PeerCtor = window.Peer || (window.peerjs && window.peerjs.Peer);

const DOOR_PREFIX = 'telinha-sala-';
const PROTO = 3;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PEOPLE = 6;
const PEER_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 20000;
const HEARTBEAT_MS = 2000;
const DEAD_AFTER_MS = 12000;
const DONATE_URL = 'https://livepix.gg/fatecafe';
const REACTIONS = ['😂', '🔥', '👏', '😮', '❤️', '💀', '👀', '🎉'];

// STUN pra descobrir o caminho direto + TURN público do PeerJS de reserva.
const DEFAULT_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
];

const QUALITY = {
  '720p30':  { label: '720p · 30 fps',               w: 1280, h: 720,  fps: 30, kbps: 2500 },
  '1080p30': { label: '1080p · 30 fps',              w: 1920, h: 1080, fps: 30, kbps: 4500 },
  '1080p60': { label: '1080p · 60 fps',              w: 1920, h: 1080, fps: 60, kbps: 8000 },
  'max60':   { label: 'Máxima (até 1440p) · 60 fps', w: 2560, h: 1440, fps: 60, kbps: 12000 },
};
const CAMERA_KBPS = 1500;
const AUDIO_KBPS = 160;
const MAX_KBPS = Math.max(...Object.values(QUALITY).map((q) => q.kbps));

const $ = (sel) => document.querySelector(sel);

const state = {
  appVersion: '0.0.0',
  portable: false,
  name: '',
  avatar: loadPref('avatar', ''),
  clientId: getClientId(),
  code: '',
  peer: null,                  // peer pessoal
  myId: '',
  leaving: false,
  inRoom: false,               // true depois de entrar de fato (antes disso não participa da eleição da porta)
  room: null,                  // { hostPub, settings:{locked, onlyHost}, blocked:[clientId], banned:[{clientId,name}], turn, ver }
  amHost: false,
  hostSig: null,
  door: { peer: null, owner: null, claiming: false, ownerLostAt: 0 },
  peers: new Map(),            // id -> ver registerConn
  local: { screen: null, camera: null },
  screenSel: null,             // { sourceId, audioMode, appTarget, audioOn }
  sa: null,                    // áudio da tela: { ctx, dest, node, loopSrc, loopTrack }
  hidden: new Set(),           // "peerId:kind" que eu tirei da tela
  gone: new Map(),             // id -> quando saiu (não reconectar por fofoca desatualizada)
  annotAllow: loadPref('annotAllow', '1') === '1',
  ctrlAllow: loadPref('ctrlAllow', '1') === '1',
  ptrColor: loadPref('ptrColor', ''),
  drawColor: loadPref('drawColor', ''),
  drawSize: Number(loadPref('drawSize', '1')) || 1,
  // Controle remoto. Como dono da tela: granted (quem controla) e pending (pedidos na fila).
  // Como quem assiste: asking (pedi e estou esperando) e controlling (estou controlando).
  ctrl: { granted: null, pending: [], asking: null, controlling: null, cooldown: new Map() },
  quality: loadPref('quality', '1080p60'),
  cameraId: loadPref('cameraId', ''),
  turn: loadTurn(),
  focusKey: null,
  knownAtJoin: new Set(),
  heartbeat: null,
  join: null,
  sounds: loadPref('sounds', '1') === '1',
  hidePreview: loadPref('hidePreview', '0') === '1',
  lastReact: 0,
};

const tiles = new Map();       // key -> { key, el, video, kind, local, peerId, stream, lastFrames, layer }
const volumes = new Map();     // peerId -> volume

/* ---------------------------------------------------------------- util */

function loadPref(key, def) {
  try { return localStorage.getItem('telinha.' + key) ?? def; } catch { return def; }
}
function savePref(key, val) {
  try { localStorage.setItem('telinha.' + key, val); } catch {}
}
function getClientId() {
  let id = loadPref('clientId', '');
  if (!/^[a-f0-9]{32}$/.test(id)) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    savePref('clientId', id);
  }
  return id;
}

function cleanTurn(t) {
  if (!t || typeof t !== 'object') return null;
  const urls = String(t.urls || '').trim();
  if (!/^turns?:[^\s]{3,200}$/.test(urls)) return null;
  return { urls, username: String(t.username || '').slice(0, 200), credential: String(t.credential || '').slice(0, 200) };
}
function loadTurn() {
  try { return cleanTurn(JSON.parse(loadPref('turn', 'null'))); } catch { return null; }
}

function iceServers() {
  const list = [...DEFAULT_ICE];
  if (state.turn) list.push(state.turn);
  const roomTurn = state.room && state.room.turn;
  if (roomTurn && (!state.turn || roomTurn.urls !== state.turn.urls)) list.push(roomTurn);
  return list;
}

function genCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function cleanName(n) {
  const s = String(n || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return s || 'Amigo';
}

function cleanAvatar(a) {
  return typeof a === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(a) && a.length < 80000 ? a : '';
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

const PALETTE = ['#d4a373', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#0a84ff', '#bf5af2', '#ffffff', '#111111'];
const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const myPtrColor = () => (isHex(state.ptrColor) ? state.ptrColor : colorFor(state.name || '?'));
const myDrawColor = () => (isHex(state.drawColor) ? state.drawColor : colorFor(state.name || '?'));

function colorFor(name) {
  const palette = ['#C8894F', '#A2564C', '#6E8F5E', '#B5754C', '#8B6A9E', '#4F8A8B', '#C0705C', '#7C8FB0'];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function avatarNode(name, avatar, extraClass = '') {
  const el = document.createElement('span');
  el.className = 'avatar ' + extraClass;
  if (avatar) {
    const img = new Image();
    img.src = avatar;
    img.alt = '';
    el.appendChild(img);
  } else {
    el.style.background = colorFor(name);
    el.textContent = name.charAt(0).toUpperCase();
  }
  return el;
}

function timeNow() {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
}

async function withBusy(btn, label, fn) {
  if (btn.classList.contains('busy')) return;
  const span = btn.querySelector('span');
  const prev = span.textContent;
  btn.classList.add('busy');
  span.textContent = label;
  try {
    await fn();
  } finally {
    btn.classList.remove('busy');
    if (span.textContent === label) span.textContent = prev;
    updateControls();
  }
}

function describePeerError(e) {
  switch (e && e.type) {
    case 'unavailable-id': return 'Esse código já está em uso.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed': return 'Sem conexão com o servidor de salas. Verifique sua internet.';
    case 'timeout': return 'O servidor de salas demorou pra responder. Tente de novo.';
    case 'browser-incompatible': return 'WebRTC indisponível.';
    default: return (e && e.message) || 'Erro desconhecido.';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- sons */

let sfxCtx = null;
function beep(kind) {
  if (!state.sounds) return;
  try {
    sfxCtx = sfxCtx || new AudioContext();
    const notes = { join: [523, 784], leave: [659, 440], chat: [880], react: [990] }[kind] || [660];
    let t = sfxCtx.currentTime;
    for (const f of notes) {
      const o = sfxCtx.createOscillator();
      const g = sfxCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(sfxCtx.destination);
      o.start(t);
      o.stop(t + 0.17);
      t += 0.11;
    }
  } catch {}
}

/* ---------------------------------------------------------------- chave do host */

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

function pubOnly(jwk) {
  return jwk && { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}
function samePub(a, b) {
  return !!(a && b && a.x === b.x && a.y === b.y);
}

async function genHostKeys() {
  const kp = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  return {
    priv: await crypto.subtle.exportKey('jwk', kp.privateKey),
    pub: pubOnly(await crypto.subtle.exportKey('jwk', kp.publicKey)),
  };
}

async function signHost(privJwk, code, peerId) {
  const key = await crypto.subtle.importKey('jwk', privJwk, ECDSA, false, ['sign']);
  return b64(await crypto.subtle.sign(SIGN, key, new TextEncoder().encode(`${code}|${peerId}`)));
}

async function verifyHost(pubJwk, code, peerId, sig) {
  try {
    if (!pubJwk || typeof sig !== 'string') return false;
    const key = await crypto.subtle.importKey('jwk', pubOnly(pubJwk), ECDSA, false, ['verify']);
    return await crypto.subtle.verify(SIGN, key, unb64(sig), new TextEncoder().encode(`${code}|${peerId}`));
  } catch {
    return false;
  }
}

function getHostKeys() {
  try { return JSON.parse(loadPref('hostKeys', '{}')) || {}; } catch { return {}; }
}
function hostKeyFor(code) {
  return getHostKeys()[code] || null;
}
function saveHostKey(code, keys) {
  const all = getHostKeys();
  all[code] = { ...keys, t: Date.now() };
  // Guarda só as 10 salas mais recentes.
  const trimmed = Object.fromEntries(Object.entries(all).sort((a, b) => b[1].t - a[1].t).slice(0, 10));
  savePref('hostKeys', JSON.stringify(trimmed));
}
function touchHostKey(code) {
  const k = hostKeyFor(code);
  if (k) saveHostKey(code, { priv: k.priv, pub: k.pub });
}

/* ---------------------------------------------------------------- estado da sala (regras do host) */

function freshRoom(hostPub) {
  return { hostPub: pubOnly(hostPub), settings: { locked: false, onlyHost: false }, blocked: [], banned: [], turn: null, ver: 1 };
}

function sanitizeRoom(r, keepPub) {
  r = r && typeof r === 'object' ? r : {};
  const s = r.settings || {};
  return {
    hostPub: keepPub || pubOnly(r.hostPub),
    settings: { locked: !!s.locked, onlyHost: !!s.onlyHost },
    blocked: (Array.isArray(r.blocked) ? r.blocked : []).filter((x) => typeof x === 'string').slice(0, 50),
    banned: (Array.isArray(r.banned) ? r.banned : [])
      .filter((b) => b && typeof b.clientId === 'string')
      .map((b) => ({ clientId: b.clientId, name: cleanName(b.name) }))
      .slice(0, 50),
    turn: cleanTurn(r.turn),
    ver: Number(r.ver) || 1,
  };
}

function isBanned(clientId) {
  return !!(state.room && state.room.banned.some((b) => b.clientId === clientId));
}

function canShare(clientId, isHost) {
  if (isHost) return true;
  if (!state.room) return true;
  if (state.room.settings.onlyHost) return false;
  return !state.room.blocked.includes(clientId);
}
const canShareMe = () => canShare(state.clientId, state.amHost);
const canSharePeer = (p) => canShare(p.clientId, p.isHost);

// Só o host chama isto.
function updateRoom(mutate) {
  if (!state.amHost) return;
  const r = sanitizeRoom(JSON.parse(JSON.stringify(state.room)), state.room.hostPub);
  mutate(r);
  r.ver = state.room.ver + 1;
  state.room = r;
  broadcast({ t: 'room', room: r });
  applyRoomEffects();
}

function applyRoomEffects() {
  if (state.peer) state.peer.options.config = { ...(state.peer.options.config || {}), iceServers: iceServers() };
  // Eu fui bloqueado? Para o que estiver transmitindo.
  if (!canShareMe() && (state.local.screen || state.local.camera)) {
    stopScreen();
    stopCamera();
    toast('O host desativou seu compartilhamento nesta sala.', 'error');
  }
  // Recusa o vídeo de quem não pode compartilhar.
  for (const p of state.peers.values()) {
    if (!canSharePeer(p)) for (const kind of Object.keys(p.in)) closeIncoming(p, kind);
  }
  $('#lockBadge').classList.toggle('hidden', !state.room.settings.locked);
  updateControls();
  updatePeopleUI();
  if (!$('#settings').classList.contains('hidden')) renderSettings();
}

/* ---------------------------------------------------------------- tela inicial */

function setHomeStatus(msg, isError = false) {
  const el = $('#homeStatus');
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}

function setBusy(busy, msg) {
  $('#createBtn').disabled = busy;
  $('#joinBtn').disabled = busy;
  document.querySelectorAll('.recent-btn').forEach((b) => (b.disabled = busy));
  if (busy) setHomeStatus(msg);
}

function requireName() {
  const raw = $('#nameInput').value.trim();
  if (!raw) {
    setHomeStatus('Digite seu nome primeiro.', true);
    $('#nameInput').focus();
    return false;
  }
  state.name = cleanName(raw);
  savePref('name', state.name);
  return true;
}

function renderHomeAvatar() {
  const box = $('#avatarPreview');
  const fresh = avatarNode(cleanName($('#nameInput').value || '?'), state.avatar, 'xl');
  fresh.id = 'avatarPreview';
  box.replaceWith(fresh);
  $('#avatarRemove').classList.toggle('hidden', !state.avatar);
}

function renderRecentRooms() {
  const box = $('#recentRooms');
  const recent = Object.entries(getHostKeys())
    .filter(([, k]) => Date.now() - k.t < 7 * 24 * 3600 * 1000)
    .sort((a, b) => b[1].t - a[1].t)
    .slice(0, 3);
  box.innerHTML = '';
  box.classList.toggle('hidden', !recent.length);
  if (!recent.length) return;
  const title = document.createElement('div');
  title.className = 'recent-title';
  title.textContent = 'Suas salas (você é o host)';
  box.appendChild(title);
  for (const [code] of recent) {
    const b = document.createElement('button');
    b.className = 'recent-btn';
    b.innerHTML = `<span>Voltar pra sala <b></b></span><span class="muted">entrar →</span>`;
    b.querySelector('b').textContent = code;
    b.addEventListener('click', () => {
      $('#codeInput').value = code;
      joinRoom();
    });
    box.appendChild(b);
  }
}

async function fileToAvatar(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Não consegui abrir essa imagem.'));
      i.src = url;
    });
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function pickAvatar() {
  const input = $('#avatarFile');
  input.value = '';
  const file = await new Promise((resolve) => {
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
  if (!file) return null;
  try {
    return await fileToAvatar(file);
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

function setAvatar(dataUrl) {
  state.avatar = cleanAvatar(dataUrl);
  savePref('avatar', state.avatar);
  renderHomeAvatar();
  if (state.peer) {
    broadcast({ t: 'profile', name: state.name, avatar: state.avatar });
    updatePeopleUI();
  }
}

/* ---------------------------------------------------------------- sessão */

function openPeer(id) {
  return new Promise((resolve, reject) => {
    const opts = { debug: 1, config: { iceServers: iceServers() } };
    const peer = id ? new PeerCtor(id, opts) : new PeerCtor(opts);
    const timer = setTimeout(() => {
      cleanup();
      peer.destroy();
      reject(Object.assign(new Error('timeout'), { type: 'timeout' }));
    }, PEER_TIMEOUT_MS);
    const onOpen = () => { cleanup(); resolve(peer); };
    const onErr = (e) => { cleanup(); peer.destroy(); reject(e); };
    function cleanup() {
      clearTimeout(timer);
      peer.off('open', onOpen);
      peer.off('error', onErr);
    }
    peer.on('open', onOpen);
    peer.on('error', onErr);
  });
}

function startSession(peer, code) {
  state.peer = peer;
  state.myId = peer.id;
  state.code = code;
  state.leaving = false;
  state.inRoom = false;
  state.amHost = false;
  state.hostSig = null;
  state.room = null;
  state.door = { peer: null, owner: null, claiming: false, ownerLostAt: Date.now() };
  state.knownAtJoin.clear();
  state.hidden.clear();
  state.gone.clear();

  peer.on('connection', onIncomingConnection);
  peer.on('call', onIncomingCall);
  peer.on('disconnected', () => {
    // Caiu só o servidor de salas; as conexões P2P continuam.
    if (state.leaving || state.peer !== peer) return;
    setTimeout(() => {
      if (state.peer === peer && !peer.destroyed && peer.disconnected) peer.reconnect();
    }, 2000);
  });
  peer.on('error', (e) => {
    if (state.peer !== peer) return;
    if (state.join) {
      const isDoor = e.type === 'peer-unavailable' && String(e.message).includes(DOOR_PREFIX + state.code);
      state.join.reject(isDoor
        ? Object.assign(new Error('Sala não encontrada. Confira o código (e se vocês estão com a mesma versão do Telinha Café).'), { code: 'no-room' })
        : new Error(describePeerError(e)));
      return;
    }
    if (e.type !== 'peer-unavailable') console.warn('peer error', e.type, e);
  });

  state.heartbeat = setInterval(heartbeat, HEARTBEAT_MS);
}

function endSession() {
  clearInterval(state.heartbeat);
  state.heartbeat = null;
  releaseDoor();
  for (const id of [...state.peers.keys()]) removePeer(id, true);
  if (state.peer) {
    try { state.peer.destroy(); } catch {}
  }
  state.peer = null;
}

async function becomeHost(keys) {
  state.amHost = true;
  if (!state.hostSig) state.hostSig = await signHost(keys.priv, state.code, state.myId);
  touchHostKey(state.code);
}

async function createRoom() {
  if (!requireName()) return;
  setBusy(true, 'Criando sala…');
  try {
    const keys = await genHostKeys();
    const peer = await openPeer();
    startSession(peer, genCode());
    state.room = freshRoom(keys.pub);
    if (state.turn) state.room.turn = state.turn;
    let ok = false;
    for (let i = 0; i < 5 && !ok; i++) {
      if (i > 0) state.code = genCode();
      try {
        await claimDoor();
        ok = true;
      } catch (e) {
        if (e.type !== 'unavailable-id') throw e;
      }
    }
    if (!ok) throw new Error('Não consegui gerar um código livre.');
    saveHostKey(state.code, keys);
    await becomeHost(keys);
    enterRoom(`Sala criada. Passe o código ${state.code} pros amigos.`);
  } catch (e) {
    endSession();
    setHomeStatus(describePeerError(e), true);
  } finally {
    setBusy(false);
  }
}

async function joinRoom() {
  if (!requireName()) return;
  const code = $('#codeInput').value.trim().toUpperCase();
  if (code.length !== 6) {
    setHomeStatus('O código tem 6 caracteres.', true);
    return;
  }
  savePref('lastCode', code);
  setBusy(true, 'Entrando na sala…');
  try {
    const peer = await openPeer();
    startSession(peer, code);
    const keys = hostKeyFor(code);
    let message = 'Você entrou na sala.';
    try {
      await doorJoin(keys);
    } catch (e) {
      if (e.code !== 'no-room') throw e;
      let reopened = false;
      if (keys) {
        // Sala vazia e eu sou o host: reabre com o mesmo código.
        setHomeStatus('Reabrindo a sala…');
        state.room = freshRoom(keys.pub);
        if (state.turn) state.room.turn = state.turn;
        try {
          await claimDoor();
          reopened = true;
          message = `Sala ${code} reaberta. Os amigos já podem entrar de novo.`;
        } catch (claimErr) {
          if (claimErr.type !== 'unavailable-id') throw claimErr;
          state.room = null; // alguém segura a porta: a sala existe
        }
      }
      if (!reopened) {
        // Pode ser a porta trocando de dono; tenta de novo antes de desistir.
        setHomeStatus('Procurando a sala…');
        await sleep(2500);
        await doorJoin(keys);
      }
    }
    if (keys && samePub(keys.pub, state.room.hostPub)) {
      await becomeHost(keys);
      if (message === 'Você entrou na sala.') message = 'Você voltou pra sala como host.';
    }
    enterRoom(message);
  } catch (e) {
    endSession();
    setHomeStatus(describePeerError(e), true);
  } finally {
    if (state.join) clearTimeout(state.join.timer);
    state.join = null;
    setBusy(false);
  }
}

// Bate na porta da sala e recebe a lista de membros + regras.
function doorJoin(keys) {
  return new Promise(async (resolve, reject) => {
    const hostSig = keys ? await signHost(keys.priv, state.code, state.myId) : undefined;
    state.hostSig = hostSig || null;
    const conn = state.peer.connect(DOOR_PREFIX + state.code, {
      reliable: true,
      serialization: 'json',
      metadata: { room: state.code, v: PROTO, version: state.appVersion, clientId: state.clientId, hostSig },
    });
    const noRoom = () => Object.assign(new Error('Sala não encontrada. Confira o código (e se vocês estão com a mesma versão do Telinha Café).'), { code: 'no-room' });
    // Se a conexão com a porta nem abre, ninguém está segurando ela (sala vazia ou código errado).
    const openTimer = setTimeout(() => done(reject, noRoom()), 8000);
    const done = (fn, arg) => {
      if (!state.join || state.join.conn !== conn) return;
      clearTimeout(state.join.timer);
      clearTimeout(openTimer);
      state.join = null;
      setTimeout(() => { try { conn.close(); } catch {} }, 500);
      fn(arg);
    };
    state.join = {
      conn,
      reject: (e) => done(reject, e),
      timer: setTimeout(() => done(reject, new Error('A sala não respondeu. Tente de novo.')), PEER_TIMEOUT_MS),
    };
    conn.on('open', () => clearTimeout(openTimer));
    conn.on('data', (d) => {
      if (!d || typeof d !== 'object') return;
      if (d.t === 'welcome') {
        state.room = sanitizeRoom(d.room);
        // Se a chave bate com a da sala, eu sou o host (antes de conectar, pro hello já ir assinado).
        if (keys && samePub(keys.pub, state.room.hostPub)) state.amHost = true;
        state.door.owner = typeof d.doorOwner === 'string' ? d.doorOwner : null;
        state.peer.options.config = { ...(state.peer.options.config || {}), iceServers: iceServers() };
        for (const m of Array.isArray(d.members) ? d.members : []) {
          if (m && typeof m.id === 'string') {
            state.knownAtJoin.add(m.id);
            connectTo(m.id, typeof m.name === 'string' ? cleanName(m.name) : null);
          }
        }
        done(resolve);
      } else if (d.t === 'reject') {
        let msg = {
          full: `A sala está cheia (máximo ${MAX_PEOPLE} pessoas).`,
          locked: 'O host trancou a sala. Ninguém novo pode entrar agora.',
          banned: 'Você foi removido dessa sala pelo host.',
        }[d.reason];
        if (d.reason === 'version') {
          msg = Number(d.proto) > PROTO
            ? `A sala está numa versão mais nova do Telinha Café (${d.version || '?'}). A sua é ${state.appVersion}: atualize pra entrar.`
            : `Quem está na sala usa uma versão mais antiga do Telinha Café (${d.version || '?'}). A sua é ${state.appVersion}: peça pra atualizarem.`;
        }
        done(reject, new Error(msg || (typeof d.msg === 'string' ? d.msg.slice(0, 200) : 'Entrada recusada.')));
      }
    });
  });
}

/* ---------------------------------------------------------------- porta da sala */

async function claimDoor() {
  if (state.door.peer || state.door.claiming) return;
  state.door.claiming = true;
  try {
    const door = await openPeer(DOOR_PREFIX + state.code);
    if (!state.peer || state.leaving) { door.destroy(); return; }
    state.door.peer = door;
    state.door.owner = state.myId;
    door.on('connection', onDoorConnection);
    door.on('disconnected', () => {
      setTimeout(() => {
        if (state.door.peer === door && !door.destroyed && door.disconnected) door.reconnect();
      }, 2000);
    });
    door.on('error', (e) => {
      if (e.type === 'unavailable-id' && state.door.peer === door) releaseDoor();
    });
    door.on('close', () => { if (state.door.peer === door) releaseDoor(); });
    broadcast({ t: 'door' });
  } finally {
    state.door.claiming = false;
  }
}

function releaseDoor() {
  const door = state.door.peer;
  state.door.peer = null;
  if (state.door.owner === state.myId) {
    state.door.owner = null;
    state.door.ownerLostAt = Date.now();
  }
  if (door) { try { door.destroy(); } catch {} }
}

function onDoorConnection(conn) {
  const md = conn.metadata || {};
  if (md.room !== state.code || !state.room) {
    conn.close();
    return;
  }
  conn.on('open', async () => {
    const room = state.room;
    if (!room) return conn.close();
    if (md.v !== PROTO) {
      conn.send({
        t: 'reject', reason: 'version', proto: PROTO, version: state.appVersion,
        msg: `Versão diferente do Telinha Café: a sala usa a ${state.appVersion}. Atualize pra entrar.`,
      });
      setTimeout(() => { try { conn.close(); } catch {} }, 3000);
      return;
    }
    const hostComing = !!md.hostSig && await verifyHost(room.hostPub, state.code, conn.peer, md.hostSig);
    const members = [
      { id: state.myId, name: state.name },
      ...[...state.peers.values()].filter((p) => p.helloed).map((p) => ({ id: p.id, name: p.name })),
    ];
    let reason = null;
    if (!hostComing) {
      if (isBanned(md.clientId)) reason = 'banned';
      else if (room.settings.locked) reason = 'locked';
      else if (members.length >= MAX_PEOPLE) reason = 'full';
    }
    conn.send(reason ? { t: 'reject', reason } : { t: 'welcome', room, doorOwner: state.myId, members });
    setTimeout(() => { try { conn.close(); } catch {} }, 3000);
  });
}

// Se ninguém está segurando a porta, o membro com menor ID assume (os outros esperam um pouco).
function doorCheck() {
  if (!state.peer || !state.inRoom || state.leaving || state.door.peer || state.door.claiming) return;
  const owner = state.door.owner;
  if (owner && (owner === state.myId || state.peers.has(owner))) return;
  if (owner) {
    state.door.owner = null;
    state.door.ownerLostAt = Date.now();
  }
  const candidates = [state.myId, ...[...state.peers.values()].filter((p) => p.helloed && p.ready).map((p) => p.id)].sort();
  const myTurn = candidates[0] === state.myId;
  if (!myTurn && Date.now() - state.door.ownerLostAt < 12000) return;
  claimDoor().catch(() => {});
}

/* ---------------------------------------------------------------- malha */

function heartbeat() {
  const now = Date.now();
  for (const p of [...state.peers.values()]) {
    if (p.ready && now - p.lastSeen > DEAD_AFTER_MS) {
      removePeer(p.id);
      continue;
    }
    if (!p.ready && now - p.createdAt > CONNECT_TIMEOUT_MS) {
      if (p.outgoing && !state.leaving) {
        addSystem(`Não consegui conectar com ${p.name && p.name !== '…' ? p.name : 'uma pessoa da sala'}. A rede de um de vocês pode estar bloqueando; tente outra rede ou configure um servidor TURN nas configurações.`);
      }
      removePeer(p.id, true);
      continue;
    }
    if (p.ready) send(p, { t: 'ping', ts: now });
  }
  // A cada ~6s, conta pros outros quem eu conheço (pega quem entrou ao mesmo tempo).
  state.beat = (state.beat || 0) + 1;
  if (state.inRoom && state.beat % 3 === 0) for (const p of state.peers.values()) if (p.helloed) send(p, peersMsg(p.id));
  doorCheck();
}

function send(p, msg) {
  try {
    if (p.conn && p.conn.open) p.conn.send(msg);
  } catch (e) {
    console.warn('send', e);
  }
}

function broadcast(msg) {
  for (const p of state.peers.values()) send(p, msg);
}

function sharingInfo(kind) {
  if (!state.local[kind]) return null;
  if (kind === 'camera') return {};
  return {
    audio: !!(state.screenSel && state.screenSel.audioOn),
    annot: state.annotAllow,
    ctrl: state.ctrlAllow && sharingWholeScreen(),
  };
}

function helloMsg() {
  return {
    t: 'hello',
    name: state.name,
    avatar: state.avatar,
    clientId: state.clientId,
    version: state.appVersion,
    hostSig: state.amHost ? state.hostSig : undefined,
    door: !!state.door.peer,
    sharing: { screen: sharingInfo('screen'), camera: sharingInfo('camera') },
  };
}

function peersMsg(exceptId) {
  return { t: 'peers', ids: [...state.peers.values()].filter((x) => x.helloed && x.id !== exceptId).map((x) => x.id) };
}

function broadcastSharing(kind) {
  broadcast({ t: 'sharing', kind, info: sharingInfo(kind) });
}

function connectTo(id, name, quiet = false) {
  if (!state.peer || typeof id !== 'string' || id === state.myId) return;
  const existing = state.peers.get(id);
  if (existing && existing.conn && existing.conn.open) return;
  const conn = state.peer.connect(id, {
    reliable: true,
    serialization: 'json',
    metadata: { room: state.code, v: PROTO },
  });
  if (conn) {
    const p = registerConn(conn);
    p.outgoing = !quiet;
    if (name && p.name === '…') p.name = name;
  }
}

function onIncomingConnection(conn) {
  const md = conn.metadata || {};
  if (md.room !== state.code || md.v !== PROTO) {
    conn.close();
    return;
  }
  registerConn(conn);
}

function registerConn(conn) {
  const id = conn.peer;
  let p = state.peers.get(id);
  if (p) {
    if (p.conn && p.conn !== conn) {
      const old = p.conn;
      p.conn = conn;
      try { old.close(); } catch {}
    }
  } else {
    p = {
      id, name: '…', avatar: '', clientId: '', version: '', conn, out: {}, in: {},
      sharing: { screen: null, camera: null },
      unsub: { screen: false, camera: false },   // essa pessoa tirou minha tela/câmera da tela dela
      ready: false, helloed: false, isHost: false, outgoing: false, relay: false,
      createdAt: Date.now(), lastSeen: Date.now(), rtt: null,
      queue: Promise.resolve(),
    };
    p.helloP = new Promise((res) => { p.helloRes = res; });
    state.peers.set(id, p);
  }

  conn.on('open', () => {
    if (p.conn !== conn) return;
    p.ready = true;
    p.lastSeen = Date.now();
    send(p, helloMsg());
    for (const kind of ['screen', 'camera']) if (state.local[kind]) callPeer(p, kind);
    setTimeout(() => detectRelay(p, conn), 3000);
  });
  conn.on('data', (d) => {
    if (p.conn !== conn) return;
    p.lastSeen = Date.now();
    // Processa em ordem (o hello verifica assinatura de forma assíncrona).
    p.queue = p.queue.then(() => handleData(p, d)).catch((e) => console.warn('handleData', e));
  });
  conn.on('close', () => {
    if (state.peers.get(id) === p && p.conn === conn) removePeer(id);
  });
  conn.on('error', (e) => console.warn('conn error', id, e));
  return p;
}

// A conexão com essa pessoa é direta ou passa por um servidor de retransmissão (TURN)?
async function detectRelay(p, conn) {
  try {
    const pc = conn.peerConnection;
    if (!pc || !state.peers.has(p.id)) return;
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    p.relay = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay');
    updatePeopleUI();
  } catch {}
}

async function handleData(p, d) {
  if (!d || typeof d !== 'object' || !state.peers.has(p.id)) return;
  switch (d.t) {
    case 'hello': {
      const clientId = typeof d.clientId === 'string' ? d.clientId.slice(0, 64) : '';
      if (isBanned(clientId)) {
        removePeer(p.id, true);
        return;
      }
      const first = !p.helloed;
      p.name = cleanName(d.name);
      p.avatar = cleanAvatar(d.avatar);
      p.clientId = clientId;
      p.version = typeof d.version === 'string' ? d.version.slice(0, 20) : '';
      p.isHost = !!d.hostSig && !!state.room && await verifyHost(state.room.hostPub, state.code, p.id, d.hostSig);
      if (d.door) state.door.owner = p.id;
      if (d.sharing && typeof d.sharing === 'object') {
        setSharing(p, 'screen', d.sharing.screen);
        setSharing(p, 'camera', d.sharing.camera);
      }
      p.helloed = true;
      p.helloRes();
      if (first) send(p, peersMsg(p.id));
      if (first && !state.knownAtJoin.has(p.id)) {
        addSystem(p.isHost ? `${p.name} (host) entrou` : `${p.name} entrou`);
        beep('join');
      }
      if (first && p.version && cmpVersion(p.version, state.appVersion) !== 0) {
        addSystem(cmpVersion(p.version, state.appVersion) > 0
          ? `${p.name} está com o Telinha Café ${p.version}, mais novo que o seu (${state.appVersion}). Vale atualizar.`
          : `${p.name} está com o Telinha Café ${p.version}, mais antigo que o seu (${state.appVersion}). Peça pra atualizar.`);
      }
      refreshTileLabels(p.id);
      updatePeopleUI();
      break;
    }
    case 'profile':
      if (!p.helloed) break;
      p.name = cleanName(d.name);
      p.avatar = cleanAvatar(d.avatar);
      refreshTileLabels(p.id);
      updatePeopleUI();
      break;
    case 'door':
      state.door.owner = p.id;
      break;
    case 'peers':
      // Completa a malha: se alguém conhece uma pessoa com quem eu ainda não falo, conecto.
      // Só o lado com ID menor inicia, pra não abrirem duas conexões ao mesmo tempo.
      for (const id of Array.isArray(d.ids) ? d.ids.slice(0, MAX_PEOPLE * 2) : []) {
        const goneAt = state.gone.get(id);
        if (goneAt && Date.now() - goneAt < 60000) continue;
        if (typeof id === 'string' && id !== state.myId && !state.peers.has(id) && state.myId < id) connectTo(id, null, true);
      }
      break;
    case 'room':
      if (p.isHost && state.room && Number(d.room && d.room.ver) > state.room.ver) {
        state.room = sanitizeRoom(d.room, state.room.hostPub);
        applyRoomEffects();
      }
      break;
    case 'kick':
      if (!p.isHost || typeof d.clientId !== 'string') break;
      if (d.clientId === state.clientId) {
        leaveRoom('Você foi removido da sala pelo host.');
        return;
      }
      for (const x of [...state.peers.values()]) {
        if (x.clientId === d.clientId) {
          addSystem(`${x.name} foi removido pelo host`);
          removePeer(x.id, true);
        }
      }
      break;
    case 'chat':
      if (typeof d.text === 'string' && d.text.trim()) {
        addChat(p, d.text.slice(0, 500), false);
        if (document.hidden || !document.hasFocus() || $('#side').classList.contains('collapsed')) beep('chat');
      }
      break;
    case 'react':
      if (REACTIONS.includes(d.emoji)) showReaction(d.emoji, p.name);
      break;
    case 'sharing':
      if (d.kind === 'screen' || d.kind === 'camera') setSharing(p, d.kind, d.info);
      break;
    case 'stop': // compatibilidade
      if (d.kind === 'screen' || d.kind === 'camera') setSharing(p, d.kind, null);
      break;
    case 'unsub':
      if (d.kind === 'screen' || d.kind === 'camera') {
        p.unsub[d.kind] = true;
        if (p.out[d.kind]) { try { p.out[d.kind].close(); } catch {} delete p.out[d.kind]; }
      }
      break;
    case 'sub':
      if (d.kind === 'screen' || d.kind === 'camera') {
        p.unsub[d.kind] = false;
        if (state.local[d.kind] && !p.out[d.kind]) callPeer(p, d.kind);
      }
      break;
    case 'annot':
      onAnnot(p, d);
      break;
    // --- controle remoto ---
    case 'ctrl-req':
      onCtrlRequest(p);
      break;
    case 'ctrl-grant':
      if (state.ctrl.asking === p.id) startControlling(p);
      break;
    case 'ctrl-deny':
      if (state.ctrl.asking === p.id) {
        state.ctrl.asking = null;
        state.ctrl.cooldown.set(p.id, Date.now());
        toast(typeof d.reason === 'string' ? d.reason.slice(0, 160) : `${p.name} recusou o pedido de controle.`, 'error');
        updateCtrlButtons();
      }
      break;
    case 'ctrl-revoke':
      if (state.ctrl.controlling === p.id) endControlling(`${p.name} encerrou o seu controle.`);
      break;
    case 'ctrl-release':
      if (state.ctrl.granted === p.id) revokeControl(`${p.name} parou de controlar sua tela.`, false);
      state.ctrl.pending = state.ctrl.pending.filter((x) => x !== p.id);
      break;
    case 'ci':
      onCtrlInput(p, d);
      break;
    case 'ping':
      send(p, { t: 'pong', ts: d.ts });
      break;
    case 'pong':
      if (typeof d.ts === 'number') {
        p.rtt = Date.now() - d.ts;
        updatePingUI(p);
      }
      break;
    case 'bye':
      removePeer(p.id);
      break;
  }
}

// Atualiza o que essa pessoa está compartilhando.
function setSharing(p, kind, info) {
  const was = p.sharing[kind];
  p.sharing[kind] = info && typeof info === 'object'
    ? (kind === 'screen' ? { audio: !!info.audio, annot: !!info.annot, ctrl: !!info.ctrl } : {})
    : null;
  if (kind === 'screen' && !(p.sharing.screen && p.sharing.screen.ctrl)) {
    // Parou de compartilhar a tela (ou desligou os pedidos): encerra meu controle/pedido.
    if (state.ctrl.controlling === p.id) endControlling('O controle acabou.');
    if (state.ctrl.asking === p.id) state.ctrl.asking = null;
  }
  if (!p.sharing[kind]) {
    // Parou: esquece que eu tinha tirado da tela (se compartilhar de novo, aparece).
    state.hidden.delete(tileKey(p.id, kind));
    if (p.in[kind] || tiles.has(tileKey(p.id, kind))) closeIncoming(p, kind);
  } else if (kind === 'screen') {
    const t = tiles.get(tileKey(p.id, 'screen'));
    if (t) updateRemoteTileExtras(t, p);
  }
  if (!!was !== !!p.sharing[kind] || kind === 'screen') {
    renderHiddenBar();
    updatePeopleUI();
  }
}

function removePeer(id, silent = false) {
  const p = state.peers.get(id);
  if (!p) return;
  state.peers.delete(id);
  state.gone.set(id, Date.now());
  for (const c of Object.values(p.out)) { try { c.close(); } catch {} }
  for (const c of Object.values(p.in)) { try { c.close(); } catch {} }
  p.out = {};
  p.in = {};
  try { p.conn.close(); } catch {}
  removeTile(tileKey(id, 'screen'));
  removeTile(tileKey(id, 'camera'));
  state.hidden.delete(tileKey(id, 'screen'));
  state.hidden.delete(tileKey(id, 'camera'));
  if (state.ctrl.granted === id) revokeControl(`${p.name} saiu; o controle da sua tela acabou.`, false);
  if (state.ctrl.pending.includes(id)) {
    const wasFirst = state.ctrl.pending[0] === id;
    state.ctrl.pending = state.ctrl.pending.filter((x) => x !== id);
    if (wasFirst) showCtrlPrompt();
  }
  if (state.ctrl.controlling === id) endControlling();
  if (state.ctrl.asking === id) state.ctrl.asking = null;
  if (state.door.owner === id) {
    state.door.owner = null;
    state.door.ownerLostAt = Date.now();
    setTimeout(doorCheck, 300);
  }
  if (!silent && p.helloed && !state.leaving) {
    addSystem(p.isHost ? `${p.name} (host) saiu. Ele pode voltar pela mesma sala.` : `${p.name} saiu`);
    beep('leave');
  }
  renderHiddenBar();
  updatePeopleUI();
}

/* ---------------------------------------------------------------- moderação (host) */

function toggleBlock(p) {
  updateRoom((r) => {
    if (r.blocked.includes(p.clientId)) r.blocked = r.blocked.filter((x) => x !== p.clientId);
    else r.blocked.push(p.clientId);
  });
  const blocked = state.room.blocked.includes(p.clientId);
  addSystem(blocked ? `Você proibiu ${p.name} de compartilhar` : `${p.name} pode compartilhar de novo`);
}

function kick(p) {
  if (!confirm(`Remover ${p.name} da sala? Ele não vai conseguir entrar de novo (dá pra desfazer nas configurações).`)) return;
  updateRoom((r) => {
    if (!r.banned.some((b) => b.clientId === p.clientId)) r.banned.push({ clientId: p.clientId, name: p.name });
  });
  broadcast({ t: 'kick', clientId: p.clientId });
  addSystem(`Você removeu ${p.name} da sala`);
  setTimeout(() => removePeer(p.id, true), 300);
}

function unban(clientId) {
  updateRoom((r) => { r.banned = r.banned.filter((b) => b.clientId !== clientId); });
}

function openPersonMenu(p, anchor) {
  const menu = $('#personMenu');
  menu.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'menu-title';
  title.textContent = p.name;
  menu.appendChild(title);
  const add = (label, fn, cls = '') => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = cls;
    b.addEventListener('click', () => { closeMenus(); fn(); });
    menu.appendChild(b);
  };
  const blocked = state.room.blocked.includes(p.clientId);
  add(blocked ? 'Permitir compartilhar' : 'Proibir de compartilhar', () => toggleBlock(p));
  add('Remover da sala', () => kick(p), 'danger');
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 220) + 'px';
  menu.style.top = r.bottom + 4 + 'px';
  menu.classList.remove('hidden');
}

function closeMenus() {
  $('#personMenu').classList.add('hidden');
  $('#reactBar').classList.add('hidden');
}

/* ---------------------------------------------------------------- mídia (chamadas) */

function setFmtpParams(line, params) {
  const [head, rest = ''] = line.split(/ (.*)/s);
  const kept = rest.split(';').filter((x) => x && !Object.keys(params).some((k) => x.trim().startsWith(k + '=')));
  for (const [k, v] of Object.entries(params)) kept.push(`${k}=${v}`);
  return `${head} ${kept.join(';')}`;
}

// Ajusta o SDP (roda dos dois lados da chamada):
//  - vídeo: H.264 primeiro (o Windows codifica na placa de vídeo: menos CPU e mais FPS) e
//    bitrate inicial alto, pra não passar os primeiros segundos borrado/travado;
//  - áudio: Opus estéreo com mais bitrate (música/jogo, não voz).
function makeSdpTransform(startKbps) {
  return (sdp) => {
    const lines = sdp.split('\r\n');
    const inserts = [];
    let section = null;
    const sections = [];
    lines.forEach((l, i) => {
      if (l.startsWith('m=')) {
        section = { kind: l.slice(2, 7), mLine: i, lines: [] };
        sections.push(section);
      } else if (section) section.lines.push(i);
    });

    for (const sec of sections) {
      const rtpmap = {};
      const apt = {};
      for (const i of sec.lines) {
        let m = lines[i].match(/^a=rtpmap:(\d+) ([\w-]+)\//);
        if (m) rtpmap[m[1]] = m[2].toUpperCase();
        m = lines[i].match(/^a=fmtp:(\d+) apt=(\d+)/);
        if (m) apt[m[2]] = m[1];
      }
      const fmtpIdx = (pt) => sec.lines.find((i) => lines[i].startsWith(`a=fmtp:${pt} `));

      if (sec.kind === 'video') {
        const h264 = Object.keys(rtpmap).filter((pt) => rtpmap[pt] === 'H264');
        const mode1 = (pt) => /packetization-mode=1/.test(lines[fmtpIdx(pt)] || '');
        h264.sort((a, b) => mode1(b) - mode1(a));
        const parts = lines[sec.mLine].split(' ');
        const pts = parts.slice(3);
        const first = [];
        for (const pt of h264) first.push(pt, ...(apt[pt] ? [apt[pt]] : []));
        const ordered = [...first.filter((x) => pts.includes(x)), ...pts.filter((x) => !first.includes(x))];
        lines[sec.mLine] = [...parts.slice(0, 3), ...ordered].join(' ');

        const hints = {
          'x-google-start-bitrate': Math.round(startKbps * 0.7),
          'x-google-min-bitrate': Math.min(800, Math.round(startKbps * 0.3)),
          'x-google-max-bitrate': MAX_KBPS,
        };
        for (const pt of Object.keys(rtpmap)) {
          if (['RTX', 'RED', 'ULPFEC', 'FLEXFEC-03'].includes(rtpmap[pt])) continue;
          const i = fmtpIdx(pt);
          if (i !== undefined) lines[i] = setFmtpParams(lines[i], hints);
          else inserts.push({ after: sec.mLine, text: `a=fmtp:${pt} ` + Object.entries(hints).map(([k, v]) => `${k}=${v}`).join(';') });
        }
      } else if (sec.kind === 'audio') {
        const opus = Object.keys(rtpmap).find((pt) => rtpmap[pt] === 'OPUS');
        const i = opus && fmtpIdx(opus);
        if (i !== undefined) lines[i] = setFmtpParams(lines[i], { stereo: 1, 'sprop-stereo': 1, maxaveragebitrate: AUDIO_KBPS * 1000 });
      }
    }
    // Linhas novas vão logo depois das já existentes da seção, de trás pra frente pra não deslocar índices.
    inserts.sort((a, b) => b.after - a.after);
    for (const ins of inserts) {
      const sec = sections.find((s) => s.mLine === ins.after);
      const lastLine = sec.lines.length ? sec.lines[sec.lines.length - 1] : sec.mLine;
      const insertAt = lines[lastLine] === '' ? lastLine : lastLine + 1;
      lines.splice(insertAt, 0, ins.text);
    }
    return lines.join('\r\n');
  };
}

function kbpsFor(kind) {
  return kind === 'screen' ? QUALITY[state.quality].kbps : CAMERA_KBPS;
}

function applySenderParams(pc, kind) {
  for (const sender of pc.getSenders()) {
    const track = sender.track;
    if (!track) continue;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) continue;
    const enc = params.encodings[0];
    if (track.kind === 'video') {
      if (kind === 'screen') {
        const q = QUALITY[state.quality];
        enc.maxBitrate = q.kbps * 1000;
        enc.maxFramerate = q.fps;
      } else {
        enc.maxBitrate = CAMERA_KBPS * 1000;
      }
    } else {
      enc.maxBitrate = AUDIO_KBPS * 1000;
    }
    sender.setParameters(params).catch((e) => console.warn('setParameters', e));
  }
}

function callPeer(p, kind, retry = true) {
  const stream = state.local[kind];
  if (!stream || !p.ready || !state.peer || p.unsub[kind]) return;
  if (p.out[kind]) { try { p.out[kind].close(); } catch {} }
  const call = state.peer.call(p.id, stream, {
    metadata: { room: state.code, kind, kbps: kbpsFor(kind) },
    sdpTransform: makeSdpTransform(kbpsFor(kind)),
  });
  if (!call) return;
  p.out[kind] = call;
  const pc = call.peerConnection;
  if (pc) {
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') applySenderParams(pc, kind);
      if (pc.connectionState === 'failed' && p.out[kind] === call && state.peers.has(p.id)) {
        // Tenta uma vez de novo antes de avisar.
        if (retry) setTimeout(() => callPeer(p, kind, false), 1500);
        else toast(`A conexão de vídeo com ${p.name} falhou. A rede de um de vocês pode estar bloqueando.`, 'error');
      }
    });
  }
  call.on('close', () => { if (p.out[kind] === call) delete p.out[kind]; });
  call.on('error', (e) => console.warn('call error', e));
}

async function onIncomingCall(call) {
  const md = call.metadata || {};
  const p = state.peers.get(call.peer);
  const kind = md.kind;
  if (!p || md.room !== state.code || (kind !== 'screen' && kind !== 'camera')) {
    try { call.close(); } catch {}
    return;
  }
  // Espera o hello (precisa saber quem é pra checar a permissão).
  await Promise.race([p.helloP, sleep(5000)]);
  if (!state.peers.has(p.id) || !canSharePeer(p)) {
    try { call.close(); } catch {}
    return;
  }
  if (state.hidden.has(tileKey(p.id, kind))) {
    // Eu tirei isso da tela: recusa e lembra a pessoa de não mandar.
    try { call.close(); } catch {}
    send(p, { t: 'unsub', kind });
    return;
  }
  if (!p.sharing[kind]) p.sharing[kind] = kind === 'screen' ? { audio: false, annot: false } : {};
  const old = p.in[kind];
  p.in[kind] = call;
  if (old && old !== call) { try { old.close(); } catch {} }

  call.on('stream', (stream) => {
    if (p.in[kind] === call) showRemote(p, kind, stream);
  });
  call.on('close', () => {
    if (p.in[kind] === call) {
      delete p.in[kind];
      removeTile(tileKey(p.id, kind));
      updatePeopleUI();
    }
  });
  call.on('error', (e) => console.warn('incoming call error', e));
  const kbps = Math.min(MAX_KBPS, Math.max(300, Number(md.kbps) || CAMERA_KBPS));
  call.answer(undefined, { sdpTransform: makeSdpTransform(kbps) });
}

function closeIncoming(p, kind) {
  const c = p.in[kind];
  delete p.in[kind];
  if (c) { try { c.close(); } catch {} }
  removeTile(tileKey(p.id, kind));
  updatePeopleUI();
}

function showRemote(p, kind, stream) {
  addTile({ key: tileKey(p.id, kind), kind, local: false, stream, peerId: p.id });
  if (kind === 'screen' && !state.focusKey) {
    state.focusKey = tileKey(p.id, kind);
    updateStageUI();
  }
  updatePeopleUI();
}

/* ---------------------------------------------------------------- tirar da tela */

function hideRemote(peerId, kind) {
  const p = state.peers.get(peerId);
  if (!p) return;
  state.hidden.add(tileKey(peerId, kind));
  send(p, { t: 'unsub', kind });   // a pessoa para de me mandar esse vídeo (economiza internet e PC)
  closeIncoming(p, kind);
  renderHiddenBar();
}

function showHidden(peerId, kind) {
  const p = state.peers.get(peerId);
  state.hidden.delete(tileKey(peerId, kind));
  if (p) send(p, { t: 'sub', kind });
  renderHiddenBar();
}

function renderHiddenBar() {
  const bar = $('#hiddenBar');
  if (!bar) return;
  const items = [];
  for (const key of state.hidden) {
    const [peerId, kind] = key.split(':');
    const p = state.peers.get(peerId);
    if (p && p.sharing[kind]) items.push({ p, kind });
  }
  bar.innerHTML = '';
  bar.classList.toggle('hidden', !items.length);
  if (!items.length) return;
  const label = document.createElement('span');
  label.className = 'muted';
  label.textContent = 'Fora da sua tela:';
  bar.appendChild(label);
  for (const { p, kind } of items) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.title = 'Mostrar de novo';
    b.append(avatarNode(p.name, p.avatar, 'sm'));
    const t = document.createElement('span');
    t.textContent = `${p.name} · ${kind === 'screen' ? 'Tela' : 'Câmera'}`;
    const plus = document.createElement('b');
    plus.textContent = 'mostrar';
    b.append(t, plus);
    b.addEventListener('click', () => showHidden(p.id, kind));
    bar.appendChild(b);
  }
  if (items.length > 1) {
    const all = document.createElement('button');
    all.className = 'link';
    all.textContent = 'mostrar todos';
    all.addEventListener('click', () => items.forEach(({ p, kind }) => showHidden(p.id, kind)));
    bar.appendChild(all);
  }
}

/* ---------------------------------------------------------------- tela */

// Captura a fonte escolhida (e o áudio do sistema, se for o modo "completo").
async function captureSource(sourceId, audioMode, q) {
  await telinha.selectSource({ id: sourceId, audio: audioMode === 'full' });
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { max: q.w }, height: { max: q.h }, frameRate: { ideal: q.fps, max: q.fps } },
    audio: audioMode === 'full',
  });
  const vt = stream.getVideoTracks()[0];
  vt.contentHint = q.fps >= 60 ? 'motion' : 'detail';
  vt.addEventListener('ended', () => {
    const s = state.local.screen;
    if (s && s.getVideoTracks()[0] === vt) stopScreen();
  });
  return { vt, loop: stream.getAudioTracks()[0] || null };
}

function audioModeLabel(mode, appTarget) {
  if (mode === 'app') return appTarget === 'window' ? 'window' : 'app';
  return mode;
}

async function startScreen(sel) {
  if (!canShareMe()) {
    toast('O host não permite que você compartilhe nesta sala.', 'error');
    return;
  }
  if (state.local.screen) return switchScreen(sel);
  const q = QUALITY[sel.quality] || QUALITY['1080p60'];
  state.quality = sel.quality;

  let cap;
  try {
    cap = await captureSource(sel.sourceId, sel.audioMode, q);
  } catch (e) {
    toast('Não consegui capturar essa tela: ' + e.message, 'error');
    return;
  }
  const sa = await ensureScreenAudio();
  const audioOn = await applyScreenAudio(sel, cap.loop);

  if (!canShareMe() || !state.peer) { // bloqueado enquanto abria
    cap.vt.stop();
    clearScreenAudioInput();
    return;
  }
  state.screenSel = { ...sel, audioOn };
  const stream = new MediaStream([cap.vt, sa.dest.stream.getAudioTracks()[0]]);
  state.local.screen = stream;
  addTile({ key: tileKey('me', 'screen'), kind: 'screen', local: true, stream, peerId: null });
  broadcastSharing('screen');
  for (const p of state.peers.values()) callPeer(p, 'screen');
  updateOverlay();
  updateControls();
  updatePeopleUI();
}

// Troca a tela/janela sem derrubar a transmissão (troca a faixa de vídeo em cada conexão).
async function switchScreen(sel) {
  const stream = state.local.screen;
  if (!stream) return startScreen(sel);
  const q = QUALITY[sel.quality] || QUALITY[state.quality];
  state.quality = sel.quality;
  let cap;
  try {
    cap = await captureSource(sel.sourceId, sel.audioMode, q);
  } catch (e) {
    toast('Não consegui capturar essa tela: ' + e.message, 'error');
    return;
  }
  if (state.local.screen !== stream) { cap.vt.stop(); return; }
  const oldVt = stream.getVideoTracks()[0];
  for (const p of state.peers.values()) {
    const pc = p.out.screen && p.out.screen.peerConnection;
    if (!pc) continue;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) {
      try {
        await sender.replaceTrack(cap.vt);
        applySenderParams(pc, 'screen');
      } catch {
        callPeer(p, 'screen');
      }
    }
  }
  stream.removeTrack(oldVt);
  stream.addTrack(cap.vt);
  oldVt.stop();

  const audioOn = await applyScreenAudio(sel, cap.loop);
  state.screenSel = { ...sel, audioOn };
  if (state.ctrl.granted) {
    // O controle acompanha a troca de monitor; se virou uma janela, acaba.
    if (sharingWholeScreen()) {
      const res = await telinha.controlStart(sel.sourceId);
      if (!res.ok) revokeControl('O controle acabou: ' + res.error, true);
    } else {
      revokeControl('O controle acabou porque agora você está compartilhando uma janela.', true);
    }
  }
  if (!sharingWholeScreen()) denyAllPending('Agora a tela compartilhada é uma janela; o controle só funciona com a tela inteira.');
  const t = tiles.get(tileKey('me', 'screen'));
  if (t) {
    t.video.srcObject = null;
    applyPreview(t);
  }
  broadcastSharing('screen');
  updateOverlay();
  updateControls();
  toast('Compartilhamento trocado.');
}

function stopScreen() {
  const s = state.local.screen;
  if (!s) return;
  revokeControl('Você parou de compartilhar; o controle acabou.', true);
  denyAllPending('Parou de compartilhar a tela.');
  state.local.screen = null;
  state.screenSel = null;
  s.getVideoTracks().forEach((t) => t.stop());
  clearScreenAudioInput();
  broadcastSharing('screen');
  for (const p of state.peers.values()) {
    p.unsub.screen = false;
    if (p.out.screen) {
      try { p.out.screen.close(); } catch {}
      delete p.out.screen;
    }
  }
  removeTile(tileKey('me', 'screen'));
  telinha.overlayHide();
  updateControls();
  updatePeopleUI();
}

async function changeLiveQuality(key) {
  const q = QUALITY[key];
  if (!q) return;
  state.quality = key;
  savePref('quality', key);
  const s = state.local.screen;
  if (!s) return;
  const vt = s.getVideoTracks()[0];
  try {
    await vt.applyConstraints({ width: { max: q.w }, height: { max: q.h }, frameRate: { ideal: q.fps, max: q.fps } });
  } catch (e) {
    console.warn('applyConstraints', e);
  }
  vt.contentHint = q.fps >= 60 ? 'motion' : 'detail';
  for (const p of state.peers.values()) {
    if (p.out.screen && p.out.screen.peerConnection) applySenderParams(p.out.screen.peerConnection, 'screen');
  }
  toast('Qualidade: ' + q.label);
}

/* ---------------------------------------------------------------- áudio da tela */

// Toda tela compartilhada leva UMA faixa de áudio (saída de um AudioContext). O que entra nela muda
// conforme o modo: nada (silêncio), AudioCap.exe (sem Discord / só um app / só a janela) ou o áudio
// completo do sistema. Assim dá pra trocar de modo/tela sem renegociar a conexão.
const WORKLET_SRC = `
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 48000;
    this.L = new Float32Array(this.size);
    this.R = new Float32Array(this.size);
    this.r = 0; this.w = 0; this.count = 0; this.primed = false;
    this.port.onmessage = (e) => this.push(e.data);
  }
  push(buf) {
    const s = new Int16Array(buf);
    const n = s.length >> 1;
    for (let i = 0; i < n; i++) {
      this.L[this.w] = s[2 * i] / 32768;
      this.R[this.w] = s[2 * i + 1] / 32768;
      this.w = (this.w + 1) % this.size;
    }
    this.count = Math.min(this.count + n, this.size);
    if (this.count >= this.size) this.r = this.w;
    if (this.count > 9600) {
      const drop = this.count - 2400;
      this.r = (this.r + drop) % this.size;
      this.count -= drop;
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    if (!this.primed) {
      if (this.count < 2400) return true;
      this.primed = true;
    }
    if (this.count < n) { this.primed = false; return true; }
    for (let i = 0; i < n; i++) {
      L[i] = this.L[this.r];
      R[i] = this.R[this.r];
      this.r = (this.r + 1) % this.size;
    }
    this.count -= n;
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
`;

async function ensureScreenAudio() {
  if (!state.sa) {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    state.sa = { ctx, dest, node: null, loopSrc: null, loopTrack: null };
  }
  await state.sa.ctx.resume();
  return state.sa;
}

function clearScreenAudioInput() {
  telinha.stopAudio();
  const sa = state.sa;
  if (!sa) return;
  if (sa.node) { try { sa.node.disconnect(); } catch {} sa.node = null; }
  if (sa.loopSrc) { try { sa.loopSrc.disconnect(); } catch {} sa.loopSrc = null; }
  if (sa.loopTrack) { sa.loopTrack.stop(); sa.loopTrack = null; }
}

// Liga a fonte de áudio escolhida. Retorna true se tem áudio de verdade indo junto.
async function applyScreenAudio(sel, loopTrack) {
  const sa = await ensureScreenAudio();
  clearScreenAudioInput();
  const mode = sel.audioMode;
  if (mode === 'none') {
    if (loopTrack) loopTrack.stop();
    return false;
  }
  if (mode === 'full') {
    if (!loopTrack) {
      toast('O Windows não entregou o áudio do sistema. Compartilhando só a imagem.', 'error');
      return false;
    }
    sa.loopTrack = loopTrack;
    sa.loopSrc = sa.ctx.createMediaStreamSource(new MediaStream([loopTrack]));
    sa.loopSrc.connect(sa.dest);
    return true;
  }
  if (loopTrack) loopTrack.stop();

  const node = new AudioWorkletNode(sa.ctx, 'pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  node.connect(sa.dest);
  sa.node = node;
  telinha.onAudioData((data) => {
    if (sa.node !== node) return;
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const buf = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer;
    node.port.postMessage(buf, [buf]);
  });

  const opts = mode === 'nodiscord' ? { mode: 'nodiscord' }
    : sel.appTarget === 'window' ? { mode: 'window', sourceId: sel.sourceId }
    : { mode: 'app', pid: Number(sel.appTarget) };
  const res = await telinha.startAudio(opts);
  if (!res.ok) {
    clearScreenAudioInput();
    toast('O áudio não funcionou (' + res.error + '). Compartilhando só a imagem.', 'error');
    return false;
  }
  if (mode === 'nodiscord') {
    toast(res.target === 'discord'
      ? 'Som do PC ligado. O Discord ficou de fora.'
      : 'Som do PC ligado. O Discord não está aberto; se abrir, ele sai do áudio automaticamente.');
  } else {
    toast(opts.mode === 'window' ? 'Som só desta janela ligado.' : 'Som só deste app ligado.');
  }
  return true;
}

telinha.onAudioStatus((st) => {
  if (!state.local.screen) return;
  if (st.type === 'error') toast(st.message, 'error');
  else if (st.type === 'exit') {
    toast('O áudio da tela parou. Use "Trocar" pra escolher outro áudio.', 'error');
    if (state.screenSel && state.screenSel.audioOn) {
      state.screenSel.audioOn = false;
      broadcastSharing('screen');
    }
  } else if (st.type === 'target' && st.target === 'discord') toast('Discord detectado: ele ficou fora do áudio.');
});

/* ---------------------------------------------------------------- ponteiro / desenho na tela */

function contentRect(video) {
  const W = video.clientWidth;
  const H = video.clientHeight;
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const s = Math.min(W / vw, H / vh);
  const w = vw * s;
  const h = vh * s;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

function annotAllowedFor(ownerId) {
  if (ownerId === state.myId) return !!state.local.screen && state.annotAllow;
  const owner = state.peers.get(ownerId);
  return !!(owner && owner.sharing.screen && owner.sharing.screen.annot);
}

// Chegou um ponteiro/risco de alguém.
function onAnnot(p, d) {
  if (typeof d.to !== 'string' || !d.a || typeof d.a !== 'object') return;
  if (!['ptr', 'stroke', 'mark'].includes(d.a.type)) return;
  if (!annotAllowedFor(d.to)) return;
  const evt = { ...d.a, from: p.id, name: p.name, color: isHex(d.a.color) ? d.a.color : colorFor(p.name) };
  drawAnnot(d.to, evt);
}

function drawAnnot(ownerId, evt) {
  const key = tileKey(ownerId === state.myId ? 'me' : ownerId, 'screen');
  const t = tiles.get(key);
  if (t && t.layer) t.layer.handle(evt);
  if (ownerId === state.myId) telinha.overlayEvent(evt);
}

// Eu apontando/desenhando na tela de outra pessoa.
function sendAnnot(ownerId, a) {
  if (!annotAllowedFor(ownerId)) return;
  a = { ...a, color: a.type === 'ptr' ? myPtrColor() : myDrawColor() };
  if (a.type === 'stroke') a.w = state.drawSize;
  broadcast({ t: 'annot', to: ownerId, a });
  drawAnnot(ownerId, { ...a, from: state.myId, name: 'Você' });
}

function setupAnnotInput(t) {
  const catcher = t.el.querySelector('.annot-catch');
  let lastPtr = 0;
  let stroke = null;   // { sid, pending, down: {x,y}, moved, timer }
  const norm = (e) => {
    const rect = t.video.getBoundingClientRect();
    const cr = contentRect(t.video);
    const x = (e.clientX - rect.left - cr.x) / cr.w;
    const y = (e.clientY - rect.top - cr.y) / cr.h;
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
  };
  const flush = (end) => {
    if (!stroke) return;
    if (stroke.pending.length || end) sendAnnot(t.peerId, { type: 'stroke', sid: stroke.sid, pts: stroke.pending, end: !!end });
    stroke.pending = [];
  };
  catcher.addEventListener('pointermove', (e) => {
    const n = norm(e);
    const now = performance.now();
    if (stroke && n) {
      stroke.pending.push(n);
      if (Math.abs(n[0] - stroke.down[0]) + Math.abs(n[1] - stroke.down[1]) > 0.01) stroke.moved = true;
    }
    if (now - lastPtr > 40) {
      lastPtr = now;
      sendAnnot(t.peerId, n ? { type: 'ptr', x: n[0], y: n[1] } : { type: 'ptr', x: null });
    }
  });
  catcher.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const n = norm(e);
    if (!n) return;
    catcher.setPointerCapture(e.pointerId);
    stroke = { sid: Math.random().toString(36).slice(2, 10), pending: [n], down: n, moved: false };
    stroke.timer = setInterval(() => { if (stroke && stroke.moved) flush(false); }, 60);
  });
  const up = (e) => {
    if (!stroke) return;
    clearInterval(stroke.timer);
    if (stroke.moved) flush(true);
    else sendAnnot(t.peerId, { type: 'mark', x: stroke.down[0], y: stroke.down[1] });
    stroke = null;
    try { catcher.releasePointerCapture(e.pointerId); } catch {}
  };
  catcher.addEventListener('pointerup', up);
  catcher.addEventListener('pointercancel', up);
  catcher.addEventListener('pointerleave', () => { if (!stroke) sendAnnot(t.peerId, { type: 'ptr', x: null }); });
  catcher.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    setDrawMode(t, false);
  });
}

function setDrawMode(t, on) {
  if (on && state.ctrl.controlling === t.peerId) return; // controlando: o mouse vai pro PC do outro
  const was = t.el.classList.contains('drawing');
  t.el.classList.toggle('drawing', !!on);
  const b = t.el.querySelector('.b-annot');
  if (b) b.classList.toggle('on', !!on);
  if (on) renderDrawTools(t);
  if (on && !was) toast('Mexa o mouse pra apontar, clique pra marcar, arraste pra riscar. Botão direito sai.');
}

// Paletinha que aparece no vídeo enquanto o lápis está ativo (cor e espessura do desenho).
function renderDrawTools(t) {
  const box = t.el.querySelector('.draw-tools');
  if (!box) return;
  box.innerHTML = '';
  const current = myDrawColor().toLowerCase();
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c.toLowerCase() === current ? ' on' : '');
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', (e) => { e.stopPropagation(); setDrawColor(c); });
    box.appendChild(b);
  }
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'swatch-custom';
  custom.title = 'Outra cor';
  custom.value = current;
  custom.addEventListener('input', () => setDrawColor(custom.value, false));
  custom.addEventListener('change', () => setDrawColor(custom.value));
  box.appendChild(custom);
  const sep = document.createElement('span');
  sep.className = 'tools-sep';
  box.appendChild(sep);
  [1, 2, 3].forEach((w) => {
    const b = document.createElement('button');
    b.className = 'size' + (state.drawSize === w ? ' on' : '');
    b.title = ['Fino', 'Médio', 'Grosso'][w - 1];
    b.innerHTML = `<i style="width:${w * 4 + 2}px;height:${w * 4 + 2}px"></i>`;
    b.addEventListener('click', (e) => { e.stopPropagation(); setDrawSize(w); });
    box.appendChild(b);
  });
}

function refreshDrawTools() {
  for (const t of tiles.values()) if (t.el.classList.contains('drawing')) renderDrawTools(t);
}

function setDrawColor(c, rerender = true) {
  if (!isHex(c)) return;
  state.drawColor = c;
  savePref('drawColor', c);
  if (rerender) refreshDrawTools();
}

function setPtrColor(c) {
  if (!isHex(c)) return;
  state.ptrColor = c;
  savePref('ptrColor', c);
}

function setDrawSize(w) {
  state.drawSize = w;
  savePref('drawSize', String(w));
  refreshDrawTools();
}

function toggleAnnotAllow() {
  state.annotAllow = !state.annotAllow;
  savePref('annotAllow', state.annotAllow ? '1' : '0');
  broadcastSharing('screen');
  updateOverlay();
  updateControls();
  const t = tiles.get(tileKey('me', 'screen'));
  if (t && t.layer && !state.annotAllow) t.layer.clear();
  toast(state.annotAllow ? 'Os amigos podem apontar e desenhar na sua tela.' : 'Ninguém mais pode apontar na sua tela.');
}

function sharingWholeScreen() {
  return !!(state.local.screen && state.screenSel && String(state.screenSel.sourceId).startsWith('screen:'));
}

// A camada por cima da tela aparece se tiver anotação liberada ou algo de controle acontecendo.
async function updateOverlay() {
  const need = sharingWholeScreen() && (state.annotAllow || state.ctrl.granted || state.ctrl.pending.length);
  if (need) {
    await telinha.overlayShow(state.screenSel.sourceId);
    updateCtrlBanner();
  } else {
    telinha.overlayHide();
  }
}

/* ---------------------------------------------------------------- controle remoto */

// Teclas permitidas (KeyboardEvent.code -> [scancode, estendida]). Posicional: funciona com
// qualquer layout (ABNT2 incluso). A tecla Windows fica de fora de propósito.
const SCANCODES = (() => {
  const m = {};
  const row = (codes, start) => codes.forEach((c, i) => { m[c] = [start + i, 0]; });
  row(['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight'], 0x10);
  row(['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote', 'Backquote'], 0x1e);
  row(['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'], 0x2c);
  row(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal', 'Backspace', 'Tab'], 0x02);
  row(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'], 0x3b);
  Object.assign(m, {
    Escape: [0x01, 0], Enter: [0x1c, 0], ControlLeft: [0x1d, 0], ShiftLeft: [0x2a, 0], Backslash: [0x2b, 0],
    ShiftRight: [0x36, 0], NumpadMultiply: [0x37, 0], AltLeft: [0x38, 0], Space: [0x39, 0], CapsLock: [0x3a, 0],
    NumLock: [0x45, 0], ScrollLock: [0x46, 0], Numpad7: [0x47, 0], Numpad8: [0x48, 0], Numpad9: [0x49, 0],
    NumpadSubtract: [0x4a, 0], Numpad4: [0x4b, 0], Numpad5: [0x4c, 0], Numpad6: [0x4d, 0], NumpadAdd: [0x4e, 0],
    Numpad1: [0x4f, 0], Numpad2: [0x50, 0], Numpad3: [0x51, 0], Numpad0: [0x52, 0], NumpadDecimal: [0x53, 0],
    IntlBackslash: [0x56, 0], F11: [0x57, 0], F12: [0x58, 0], IntlRo: [0x73, 0], NumpadComma: [0x7e, 0],
    NumpadEnter: [0x1c, 1], ControlRight: [0x1d, 1], NumpadDivide: [0x35, 1], AltRight: [0x38, 1],
    Home: [0x47, 1], ArrowUp: [0x48, 1], PageUp: [0x49, 1], ArrowLeft: [0x4b, 1], ArrowRight: [0x4d, 1],
    End: [0x4f, 1], ArrowDown: [0x50, 1], PageDown: [0x51, 1], Insert: [0x52, 1], Delete: [0x53, 1], ContextMenu: [0x5d, 1],
  });
  return m;
})();

// ---- dono da tela ----

function onCtrlRequest(p) {
  if (!sharingWholeScreen() || !state.ctrlAllow) {
    send(p, { t: 'ctrl-deny', reason: !state.ctrlAllow ? `${state.name} não está aceitando pedidos de controle.` : 'O controle só funciona quando a pessoa compartilha a tela inteira.' });
    return;
  }
  if (state.ctrl.granted === p.id) { send(p, { t: 'ctrl-grant' }); return; }
  if (state.ctrl.pending.includes(p.id)) return;
  state.ctrl.pending.push(p.id);
  if (state.ctrl.pending.length === 1) showCtrlPrompt();
}

function showCtrlPrompt() {
  const modal = $('#ctrlPrompt');
  while (state.ctrl.pending.length && !state.peers.has(state.ctrl.pending[0])) state.ctrl.pending.shift();
  const id = state.ctrl.pending[0];
  if (!id) {
    modal.classList.add('hidden');
    telinha.controlPending(false);
    updateOverlay();
    return;
  }
  const p = state.peers.get(id);
  $('#ctrlPromptText').textContent = `${p.name} quer controlar o mouse e o teclado da sua tela.`;
  $('#ctrlPromptWarn').textContent = state.ctrl.granted && state.peers.get(state.ctrl.granted)
    ? `Se aceitar, ${state.peers.get(state.ctrl.granted).name} para de controlar.`
    : '';
  modal.classList.remove('hidden');
  telinha.controlPending(true);
  beep('join');
  updateOverlay();
}

async function answerCtrl(accept) {
  const id = state.ctrl.pending.shift();
  const p = id && state.peers.get(id);
  if (p) {
    if (accept && sharingWholeScreen()) {
      if (state.ctrl.granted && state.ctrl.granted !== id) revokeControl(null, true);
      const res = await telinha.controlStart(state.screenSel.sourceId);
      if (res.ok) {
        state.ctrl.granted = id;
        send(p, { t: 'ctrl-grant' });
        addSystem(`${p.name} está controlando sua tela. Ctrl+Alt+X para parar a qualquer momento.`);
      } else {
        send(p, { t: 'ctrl-deny', reason: 'Não deu pra liberar o controle: ' + res.error });
        toast(res.error, 'error');
      }
    } else {
      send(p, { t: 'ctrl-deny', reason: `${state.name} recusou o pedido de controle.` });
    }
  }
  showCtrlPrompt();
  updateCtrlBanner();
  updateControls();
}

// Corta o controle. notify = avisar quem controlava.
function revokeControl(message, notify = true) {
  const id = state.ctrl.granted;
  if (!id) return;
  state.ctrl.granted = null;
  telinha.controlStop();
  const p = state.peers.get(id);
  if (p && notify) send(p, { t: 'ctrl-revoke' });
  if (message !== null) addSystem(message || `Você encerrou o controle de ${p ? p.name : 'outra pessoa'}.`);
  updateCtrlBanner();
  updateOverlay();
  updateControls();
}

function denyAllPending(reason) {
  const list = state.ctrl.pending;
  state.ctrl.pending = [];
  for (const id of list) {
    const p = state.peers.get(id);
    if (p) send(p, { t: 'ctrl-deny', reason });
  }
  if (list.length) showCtrlPrompt();
}

function onCtrlInput(p, d) {
  if (state.ctrl.granted !== p.id) return;
  switch (d.k) {
    case 'm':
      telinha.controlInput({ k: 'm', x: Number(d.x), y: Number(d.y) });
      break;
    case 'd':
    case 'u':
      if ([0, 1, 2].includes(d.b)) telinha.controlInput({ k: d.k, b: d.b });
      break;
    case 'w':
      telinha.controlInput({ k: 'w', d: Math.sign(Number(d.d) || 0) * 120 });
      break;
    case 'kd':
    case 'ku': {
      const sc = SCANCODES[d.c];
      if (sc) telinha.controlInput({ k: d.k, sc: sc[0], ext: sc[1] });
      break;
    }
    case 'reset':
      telinha.controlInput({ k: 'reset' });
      break;
  }
}

// Aviso na barra do app e por cima da tela (camada fora da transmissão).
function updateCtrlBanner() {
  const bar = $('#ctrlBar');
  let text = '';
  let tone = '';
  const pendingP = state.ctrl.pending.length && state.peers.get(state.ctrl.pending[0]);
  const grantedP = state.ctrl.granted && state.peers.get(state.ctrl.granted);
  if (pendingP) {
    text = `🖱 ${pendingP.name} quer controlar sua tela · Ctrl+Alt+Y aceita · Ctrl+Alt+N recusa`;
    tone = 'warn';
  } else if (grantedP) {
    text = `🖱 ${grantedP.name} está controlando sua tela · Ctrl+Alt+X para parar`;
    tone = 'live';
  }
  telinha.overlayEvent({ type: 'banner', text, tone });
  bar.classList.toggle('hidden', !grantedP);
  if (grantedP) $('#ctrlBarText').textContent = `${grantedP.name} está controlando sua tela.`;
}

function toggleCtrlAllow(v) {
  state.ctrlAllow = v;
  savePref('ctrlAllow', v ? '1' : '0');
  if (!v) {
    revokeControl('Você desligou os pedidos de controle; o controle acabou.', true);
    denyAllPending(`${state.name} desligou os pedidos de controle.`);
  }
  if (state.local.screen) broadcastSharing('screen');
}

telinha.onControlShortcut((action) => {
  if (action === 'revoke') revokeControl(null, true);
  else if (action === 'accept' && state.ctrl.pending.length) answerCtrl(true);
  else if (action === 'deny' && state.ctrl.pending.length) answerCtrl(false);
});
telinha.onControlEnded(() => revokeControl('O controle parou (o programa de controle fechou).', true));

// ---- quem assiste / controla ----

function requestControl(t) {
  const p = state.peers.get(t.peerId);
  if (!p) return;
  if (state.ctrl.controlling === p.id) { stopControlling(); return; }
  if (state.ctrl.asking) return;
  const last = state.ctrl.cooldown.get(p.id) || 0;
  if (Date.now() - last < 15000) {
    toast('Espere uns segundos antes de pedir de novo.', 'error');
    return;
  }
  state.ctrl.asking = p.id;
  send(p, { t: 'ctrl-req' });
  toast(`Pedido enviado. Esperando ${p.name} aceitar…`);
  updateCtrlButtons();
  setTimeout(() => {
    if (state.ctrl.asking === p.id) {
      state.ctrl.asking = null;
      updateCtrlButtons();
      toast(`${p.name} não respondeu ao pedido de controle.`, 'error');
    }
  }, 60000);
}

function startControlling(p) {
  state.ctrl.asking = null;
  state.ctrl.controlling = p.id;
  const t = tiles.get(tileKey(p.id, 'screen'));
  if (t) {
    setDrawMode(t, false);
    t.el.classList.add('controlling');
    state.focusKey = t.key;
    updateStageUI();
    t.el.querySelector('.ctrl-catch').focus();
  }
  addSystem(`Você está controlando a tela de ${p.name}. Clique no vídeo e use mouse e teclado; Ctrl+Alt+X ou o botão 🖱 param.`);
  updateCtrlButtons();
}

function stopControlling() {
  const id = state.ctrl.controlling;
  if (!id) return;
  const p = state.peers.get(id);
  if (p) {
    send(p, { t: 'ci', k: 'reset' });
    send(p, { t: 'ctrl-release' });
  }
  endControlling('Você parou de controlar.');
}

function endControlling(message) {
  const id = state.ctrl.controlling;
  if (!id) return;
  state.ctrl.controlling = null;
  const t = tiles.get(tileKey(id, 'screen'));
  if (t) t.el.classList.remove('controlling');
  if (message) toast(message);
  updateCtrlButtons();
}

function updateCtrlButtons() {
  for (const t of tiles.values()) {
    const b = t.el.querySelector('.b-ctrl');
    if (!b) continue;
    const p = state.peers.get(t.peerId);
    const allowed = !!(p && p.sharing.screen && p.sharing.screen.ctrl);
    b.classList.toggle('hidden', !allowed && state.ctrl.controlling !== t.peerId);
    b.classList.toggle('on', state.ctrl.controlling === t.peerId);
    b.classList.toggle('waiting', state.ctrl.asking === t.peerId);
    b.title = state.ctrl.controlling === t.peerId ? 'Parar de controlar'
      : state.ctrl.asking === t.peerId ? 'Esperando a pessoa aceitar…'
      : 'Pedir pra controlar essa tela (mouse e teclado)';
  }
}

// Captura mouse e teclado sobre o vídeo e manda pra quem está compartilhando.
function setupCtrlInput(t) {
  const catcher = t.el.querySelector('.ctrl-catch');
  const held = new Set();
  const buttons = new Set();
  let lastMove = 0;
  const target = () => (state.ctrl.controlling === t.peerId ? state.peers.get(t.peerId) : null);
  const norm = (e) => {
    const rect = t.video.getBoundingClientRect();
    const cr = contentRect(t.video);
    const x = (e.clientX - rect.left - cr.x) / cr.w;
    const y = (e.clientY - rect.top - cr.y) / cr.h;
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  };
  const releaseAll = () => {
    const p = target();
    if (p && (held.size || buttons.size)) send(p, { t: 'ci', k: 'reset' });
    held.clear();
    buttons.clear();
  };
  catcher.addEventListener('pointermove', (e) => {
    const p = target();
    if (!p) return;
    const now = performance.now();
    if (now - lastMove < 16) return;
    lastMove = now;
    const [x, y] = norm(e);
    send(p, { t: 'ci', k: 'm', x: Math.round(x * 100000) / 100000, y: Math.round(y * 100000) / 100000 });
  });
  catcher.addEventListener('pointerdown', (e) => {
    const p = target();
    if (!p || e.button > 2) return;
    e.preventDefault();
    catcher.focus();
    catcher.setPointerCapture(e.pointerId);
    const [x, y] = norm(e);
    send(p, { t: 'ci', k: 'm', x, y });
    send(p, { t: 'ci', k: 'd', b: e.button });
    buttons.add(e.button);
  });
  catcher.addEventListener('pointerup', (e) => {
    const p = target();
    if (!p || e.button > 2) return;
    send(p, { t: 'ci', k: 'u', b: e.button });
    buttons.delete(e.button);
  });
  catcher.addEventListener('wheel', (e) => {
    const p = target();
    if (!p) return;
    e.preventDefault();
    if (e.deltaY) send(p, { t: 'ci', k: 'w', d: e.deltaY < 0 ? 120 : -120 });
  }, { passive: false });
  catcher.addEventListener('contextmenu', (e) => e.preventDefault());
  catcher.addEventListener('keydown', (e) => {
    const p = target();
    if (!p) return;
    if (e.ctrlKey && e.altKey && e.code === 'KeyX') {
      e.preventDefault();
      releaseAll();
      stopControlling();
      return;
    }
    e.preventDefault();
    if (!SCANCODES[e.code]) return;
    held.add(e.code);
    send(p, { t: 'ci', k: 'kd', c: e.code });
  });
  catcher.addEventListener('keyup', (e) => {
    const p = target();
    if (!p) return;
    e.preventDefault();
    if (!SCANCODES[e.code]) return;
    held.delete(e.code);
    send(p, { t: 'ci', k: 'ku', c: e.code });
  });
  // Saiu da janela/vídeo com tecla ou botão apertado: solta tudo do outro lado.
  catcher.addEventListener('blur', releaseAll);
}

/* ---------------------------------------------------------------- câmera */

async function startCamera(deviceId) {
  if (!canShareMe()) {
    toast('O host não permite que você compartilhe nesta sala.', 'error');
    return;
  }
  if (state.local.camera) stopCamera();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
  } catch (e) {
    if (deviceId && e.name === 'OverconstrainedError') return startCamera('');
    const msg = e.name === 'NotFoundError' ? 'Nenhuma câmera encontrada.'
      : e.name === 'NotReadableError' ? 'A câmera está sendo usada por outro programa.'
      : 'Não consegui abrir a câmera: ' + e.message;
    toast(msg, 'error');
    return;
  }
  if (!canShareMe() || !state.peer) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  const vt = stream.getVideoTracks()[0];
  vt.contentHint = 'motion';
  vt.addEventListener('ended', () => { if (state.local.camera === stream) stopCamera(); });
  state.cameraId = vt.getSettings().deviceId || deviceId || '';
  savePref('cameraId', state.cameraId);

  state.local.camera = stream;
  addTile({ key: tileKey('me', 'camera'), kind: 'camera', local: true, stream, peerId: null });
  broadcastSharing('camera');
  for (const p of state.peers.values()) callPeer(p, 'camera');
  await refreshCameraList();
  updateControls();
  updatePeopleUI();
}

function stopCamera() {
  const s = state.local.camera;
  if (!s) return;
  state.local.camera = null;
  s.getTracks().forEach((t) => t.stop());
  broadcastSharing('camera');
  for (const p of state.peers.values()) {
    p.unsub.camera = false;
    if (p.out.camera) {
      try { p.out.camera.close(); } catch {}
      delete p.out.camera;
    }
  }
  removeTile(tileKey('me', 'camera'));
  updateControls();
  updatePeopleUI();
}

async function refreshCameraList() {
  const sel = $('#camSelect');
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  sel.innerHTML = '';
  devices.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Câmera ${i + 1}`;
    sel.appendChild(o);
  });
  sel.value = state.cameraId;
  sel.dataset.count = devices.length;
}

/* ---------------------------------------------------------------- tiles */

function tileKey(peerId, kind) {
  return `${peerId}:${kind}`;
}

const ICON_FOCUS = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 5v4h2V5h4V3H5a2 2 0 0 0-2 2zm2 10H3v4a2 2 0 0 0 2 2h4v-2H5v-4zm14 4h-4v2h4a2 2 0 0 0 2-2v-4h-2v4zm0-16h-4v2h4v4h2V5a2 2 0 0 0-2-2z"/></svg>';
const ICON_FULL = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
const ICON_VOL = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z"/></svg>';
const ICON_PIP = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 11h-8v6h8v-6zm4 8V5a2 2 0 0 0-2-2H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2zm-2 0H3V5h18v14z"/></svg>';
const ICON_EYE = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>';
const ICON_PEN = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
const ICON_MOUSE = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M13 1.07V9h7c0-4.08-3.05-7.44-7-7.93zM4 15c0 4.42 3.58 8 8 8s8-3.58 8-8v-4H4v4zm7-13.93C7.05 1.56 4 4.92 4 9h7V1.07z"/></svg>';
const ICON_HIDE ='<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

function addTile({ key, kind, local, stream, peerId }) {
  let t = tiles.get(key);
  if (!t) {
    const el = document.createElement('div');
    el.className = `tile ${kind}${local ? ' local' : ''}`;
    const pipOk = !local && document.pictureInPictureEnabled;
    const isScreen = kind === 'screen';
    el.innerHTML = `
      <video autoplay playsinline></video>
      ${isScreen ? '<canvas class="annot"></canvas>' : ''}
      ${isScreen && !local ? '<div class="annot-catch"></div><div class="ctrl-catch" tabindex="0"></div><div class="draw-tools"></div>' : ''}
      <div class="tile-label"><span class="live"></span><span class="lbl"></span><span class="stats"></span></div>
      <div class="tile-bar">
        <span class="vol hidden" title="Volume">${ICON_VOL}<input type="range" min="0" max="1" step="0.01"></span>
        <span></span>
        <span class="tile-actions">
          ${isScreen && !local ? `<button class="icon-btn b-ctrl hidden" title="Pedir pra controlar essa tela">${ICON_MOUSE}</button>` : ''}
          ${isScreen && !local ? `<button class="icon-btn b-annot hidden" title="Apontar/desenhar na tela">${ICON_PEN}</button>` : ''}
          ${local && isScreen ? `<button class="icon-btn b-preview" title="Ocultar/mostrar minha prévia">${ICON_EYE}</button>` : ''}
          ${pipOk ? `<button class="icon-btn b-pip" title="Janela flutuante (por cima de tudo)">${ICON_PIP}</button>` : ''}
          <button class="icon-btn b-focus" title="Destacar">${ICON_FOCUS}</button>
          <button class="icon-btn b-full" title="Tela cheia">${ICON_FULL}</button>
          ${!local ? `<button class="icon-btn b-hide" title="Tirar da minha tela (para de receber)">${ICON_HIDE}</button>` : ''}
        </span>
      </div>`;
    const video = el.querySelector('video');
    video.muted = !!local;
    const range = el.querySelector('.vol input');
    range.value = volumes.has(peerId) ? volumes.get(peerId) : 1;
    video.volume = Number(range.value);
    range.addEventListener('input', () => {
      video.volume = Number(range.value);
      if (peerId) volumes.set(peerId, video.volume);
    });
    t = { key, el, video, kind, local, peerId, stream, lastFrames: 0, layer: null };
    el.querySelector('.b-focus').addEventListener('click', () => toggleFocus(key));
    el.querySelector('.b-full').addEventListener('click', () => toggleFullscreen(el));
    const pip = el.querySelector('.b-pip');
    if (pip) pip.addEventListener('click', () => togglePip(video));
    const prev = el.querySelector('.b-preview');
    if (prev) prev.addEventListener('click', () => setHidePreview(!state.hidePreview));
    const hide = el.querySelector('.b-hide');
    if (hide) hide.addEventListener('click', () => hideRemote(peerId, kind));
    const annotBtn = el.querySelector('.b-annot');
    if (annotBtn) annotBtn.addEventListener('click', () => setDrawMode(t, !el.classList.contains('drawing')));
    const ctrlBtn = el.querySelector('.b-ctrl');
    if (ctrlBtn) ctrlBtn.addEventListener('click', () => requestControl(t));
    if (el.querySelector('.ctrl-catch')) setupCtrlInput(t);
    video.addEventListener('dblclick', () => toggleFullscreen(el));
    const canvas = el.querySelector('canvas.annot');
    if (canvas) t.layer = new AnnotLayer(canvas, () => contentRect(video));
    if (el.querySelector('.annot-catch')) setupAnnotInput(t);
    tiles.set(key, t);
    $('#grid').appendChild(el);
  }
  t.stream = stream;
  applyPreview(t);

  const updateVol = () => {
    const p = peerId && state.peers.get(peerId);
    const hasAudio = !local && (kind === 'screen' ? !!(p && p.sharing.screen && p.sharing.screen.audio) : stream.getAudioTracks().length > 0);
    t.el.querySelector('.vol').classList.toggle('hidden', !hasAudio);
  };
  t.updateVol = updateVol;
  updateVol();
  if (!local && kind === 'screen') updateRemoteTileExtras(t, state.peers.get(peerId));

  refreshTileLabel(t);
  updateStageUI();
}

// Mostra/esconde o volume e o lápis conforme o que a pessoa está mandando.
function updateRemoteTileExtras(t, p) {
  if (!p) return;
  if (t.updateVol) t.updateVol();
  const allowed = !!(p.sharing.screen && p.sharing.screen.annot);
  const b = t.el.querySelector('.b-annot');
  if (b) b.classList.toggle('hidden', !allowed);
  if (!allowed) {
    setDrawMode(t, false);
    if (t.layer) t.layer.clear();
  }
  updateCtrlButtons();
}

// Prévia da minha própria tela: dá pra esconder pra economizar PC.
function applyPreview(t) {
  const hide = t.local && t.kind === 'screen' && state.hidePreview;
  let overlay = t.el.querySelector('.preview-off');
  if (hide) {
    t.video.srcObject = null;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'preview-off';
      overlay.innerHTML = '<b>Você está compartilhando</b><span>Prévia oculta pra economizar o PC</span>';
      t.el.insertBefore(overlay, t.el.querySelector('.tile-label'));
    }
  } else {
    if (overlay) overlay.remove();
    if (t.video.srcObject !== t.stream) t.video.srcObject = t.stream;
    t.video.play().catch(() => {});
  }
}

function setHidePreview(hide) {
  state.hidePreview = hide;
  savePref('hidePreview', hide ? '1' : '0');
  const t = tiles.get(tileKey('me', 'screen'));
  if (t) applyPreview(t);
}

async function togglePip(video) {
  try {
    if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  } catch (e) {
    toast('Não consegui abrir a janela flutuante: ' + e.message, 'error');
  }
}

function refreshTileLabel(t) {
  const who = t.local ? 'Você' : (state.peers.get(t.peerId) || {}).name || '…';
  t.el.querySelector('.lbl').textContent = `${who} · ${t.kind === 'screen' ? 'Tela' : 'Câmera'}`;
}

function refreshTileLabels(peerId) {
  for (const t of tiles.values()) if (t.peerId === peerId) refreshTileLabel(t);
}

// Resolução e FPS reais de cada vídeo recebido.
setInterval(() => {
  for (const t of tiles.values()) {
    if (t.local || !t.video.srcObject) continue;
    const q = t.video.getVideoPlaybackQuality();
    const fps = q.totalVideoFrames - t.lastFrames;
    t.lastFrames = q.totalVideoFrames;
    t.el.querySelector('.stats').textContent = t.video.videoHeight ? `${t.video.videoHeight}p · ${fps} fps` : '';
  }
}, 1000);

function removeTile(key) {
  const t = tiles.get(key);
  if (!t) return;
  if (t.kind === 'screen' && t.peerId && state.ctrl.controlling === t.peerId) stopControlling();
  if (document.fullscreenElement === t.el) document.exitFullscreen().catch(() => {});
  if (document.pictureInPictureElement === t.video) document.exitPictureInPicture().catch(() => {});
  t.video.srcObject = null;
  t.el.remove();
  tiles.delete(key);
  if (state.focusKey === key) state.focusKey = null;
  updateStageUI();
}

function toggleFocus(key) {
  state.focusKey = state.focusKey === key ? null : key;
  updateStageUI();
}

function toggleFullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else el.requestFullscreen().catch(() => {});
}

function updateStageUI() {
  const focusArea = $('#focusArea');
  const grid = $('#grid');
  const focused = state.focusKey ? tiles.get(state.focusKey) : null;
  if (!focused) state.focusKey = null;
  for (const t of tiles.values()) {
    const target = t === focused ? focusArea : grid;
    if (t.el.parentElement !== target) {
      target.appendChild(t.el);
      if (t.video.srcObject) t.video.play().catch(() => {});
    }
    t.el.querySelector('.b-focus').title = t === focused ? 'Voltar pra grade' : 'Destacar';
  }
  $('#stage').classList.toggle('focus-mode', !!focused);
  focusArea.classList.toggle('hidden', !focused);
  const anyHidden = !$('#hiddenBar').classList.contains('hidden');
  $('#emptyState').classList.toggle('hidden', tiles.size > 0);
  $('#emptyState').classList.toggle('with-hidden', anyHidden);
  layoutGrid();
}

// Escolhe o número de colunas que deixa os vídeos (16:9) o maior possível.
function layoutGrid() {
  const grid = $('#grid');
  const items = [...grid.children];
  if ($('#stage').classList.contains('focus-mode') || !items.length) {
    grid.style.gridTemplateColumns = '';
    return;
  }
  const gap = 10;
  const W = grid.clientWidth;
  const H = grid.clientHeight;
  const n = items.length;
  let best = { w: 0, cols: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * 16 / 9);
    if (w > best.w) best = { w, cols };
  }
  grid.style.gridTemplateColumns = `repeat(${best.cols}, ${Math.max(160, Math.floor(best.w))}px)`;
}

new ResizeObserver(() => layoutGrid()).observe(document.getElementById('stage'));

/* ---------------------------------------------------------------- reações */

function sendReaction(emoji) {
  const now = Date.now();
  if (now - state.lastReact < 350) return;
  state.lastReact = now;
  broadcast({ t: 'react', emoji });
  showReaction(emoji, 'Você');
}

function showReaction(emoji, who) {
  const layer = $('#reactions');
  if (layer.childElementCount > 25) return;
  const el = document.createElement('div');
  el.className = 'reaction';
  el.style.left = 6 + Math.random() * 30 + '%';
  const e = document.createElement('span');
  e.className = 'emo';
  e.textContent = emoji;
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = who;
  el.append(e, w);
  layer.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

/* ---------------------------------------------------------------- UI da sala */

function enterRoom(message) {
  state.inRoom = true;
  $('#home').classList.add('hidden');
  $('#room').classList.remove('hidden');
  $('#codeText').textContent = state.code;
  $('#emptyCode').textContent = state.code;
  $('#roleBadge').classList.toggle('hidden', !state.amHost);
  $('#lockBadge').classList.toggle('hidden', !state.room.settings.locked);
  document.title = `Telinha Café · ${state.code}`;
  $('#chatLog').innerHTML = '';
  addSystem(message);
  setHomeStatus('');
  renderHiddenBar();
  updateControls();
  updatePeopleUI();
  updateStageUI();
}

function leaveRoom(reason) {
  if (state.leaving) return;
  state.leaving = true;
  state.inRoom = false;
  stopControlling();
  state.ctrl.asking = null;
  releaseDoor(); // outra pessoa assume a porta
  broadcast({ t: 'bye' });
  stopScreen();
  stopCamera();
  closePicker();
  closeSettings();
  closeMenus();
  setTimeout(() => {
    endSession();
    for (const key of [...tiles.keys()]) removeTile(key);
    state.focusKey = null;
    state.hidden.clear();
    renderHiddenBar();
    $('#room').classList.add('hidden');
    $('#home').classList.remove('hidden');
    document.title = 'Telinha Café';
    renderRecentRooms();
    setHomeStatus(reason || '', !!reason);
  }, 250);
}

function updateControls() {
  const sharing = !!state.local.screen;
  const cam = !!state.local.camera;
  const allowed = canShareMe();
  const why = allowed ? '' : 'O host não permite que você compartilhe';

  const sb = $('#screenBtn');
  sb.classList.toggle('on', sharing);
  sb.querySelector('span').textContent = sharing ? 'Parar tela' : 'Compartilhar tela';
  sb.disabled = !sharing && !allowed;
  sb.title = why;
  $('#switchBtn').classList.toggle('hidden', !sharing);
  const ab = $('#annotBtn');
  ab.classList.toggle('hidden', !sharing);
  ab.classList.toggle('on', state.annotAllow);
  ab.title = state.annotAllow
    ? 'Os amigos podem apontar/desenhar na sua tela (clique pra desativar)'
    : 'Ninguém pode apontar na sua tela (clique pra permitir)';
  const ql = $('#qualityLive');
  ql.classList.toggle('hidden', !sharing);
  ql.value = state.quality;

  const cb = $('#camBtn');
  cb.classList.toggle('on', cam);
  cb.querySelector('span').textContent = cam ? 'Desligar câmera' : 'Câmera';
  cb.disabled = !cam && !allowed;
  cb.title = why;
  $('#camSelect').classList.toggle('hidden', !cam || Number($('#camSelect').dataset.count || 0) < 2);
}

function pingClass(rtt) {
  if (rtt == null) return '';
  return rtt < 80 ? 'good' : rtt < 180 ? 'mid' : 'bad';
}

function updatePingUI(p) {
  const el = document.querySelector(`#peopleList li[data-id="${CSS.escape(p.id)}"] .ping`);
  if (el) {
    el.textContent = p.rtt == null ? '' : `${p.rtt} ms`;
    el.className = 'ping ' + pingClass(p.rtt);
  }
}

function updatePeopleUI() {
  const list = $('#peopleList');
  if (!list) return;
  list.innerHTML = '';
  const people = [{
    id: state.myId, name: state.name, avatar: state.avatar, me: true, host: state.amHost,
    screen: !!state.local.screen, camera: !!state.local.camera, blocked: !canShareMe() && !state.amHost,
  }];
  for (const p of state.peers.values()) {
    if (!p.helloed) continue;
    people.push({
      id: p.id, p, name: p.name, avatar: p.avatar, me: false, host: p.isHost, rtt: p.rtt,
      screen: !!p.sharing.screen, camera: !!p.sharing.camera, relay: p.relay,
      blocked: !canSharePeer(p), version: p.version,
    });
  }
  for (const person of people) {
    const li = document.createElement('li');
    li.dataset.id = person.id;
    const nm = document.createElement('span');
    nm.className = 'person-name';
    nm.textContent = person.name + (person.me ? ' (você)' : '');
    const tags = document.createElement('span');
    tags.className = 'person-tags';
    const addTag = (text, cls = '', title = '') => {
      const t = document.createElement('span');
      t.className = 'tag ' + cls;
      t.textContent = text;
      if (title) t.title = title;
      tags.appendChild(t);
    };
    if (person.host) addTag('host');
    if (person.screen) addTag('tela', 'on');
    if (person.camera) addTag('câmera', 'on');
    if (person.blocked && state.room && !state.room.settings.onlyHost) addTag('bloqueado', 'blocked');
    if (person.relay) addTag('via servidor', '', 'A conexão com essa pessoa passa por um servidor de retransmissão (a rede não permitiu conexão direta). Funciona, mas pode ter mais atraso.');
    if (person.version && cmpVersion(person.version, state.appVersion) !== 0) addTag('v' + person.version, 'blocked', 'Versão diferente da sua');
    const ping = document.createElement('span');
    ping.className = 'ping ' + pingClass(person.rtt);
    ping.textContent = person.rtt == null || person.me ? '' : `${person.rtt} ms`;
    li.append(avatarNode(person.name, person.avatar), nm, tags, ping);
    if (state.amHost && !person.me && person.p) {
      li.classList.add('clickable');
      li.title = 'Clique pra moderar';
      li.addEventListener('click', (e) => {
        e.stopPropagation();
        openPersonMenu(person.p, li);
      });
    }
    list.appendChild(li);
  }
  $('#peopleCount').textContent = `(${people.length}/${MAX_PEOPLE})`;
  const hostHere = state.amHost || [...state.peers.values()].some((p) => p.isHost);
  $('#hostAway').classList.toggle('hidden', hostHere);
}

/* ---------------------------------------------------------------- chat */

function addChat(from, text, mine) {
  const name = mine ? state.name : from.name;
  const avatar = mine ? state.avatar : from.avatar;
  const el = document.createElement('div');
  el.className = 'msg';
  const body = document.createElement('div');
  body.className = 'msg-body';
  const who = document.createElement('span');
  who.className = 'who';
  who.style.color = colorFor(name);
  who.textContent = mine ? `${name} (você)` : name;
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = timeNow();
  const txt = document.createElement('div');
  txt.className = 'text';
  txt.textContent = text;
  body.append(who, when, txt);
  el.append(avatarNode(name, avatar, 'sm'), body);
  appendToChat(el);
  if (!mine && $('#side').classList.contains('collapsed')) $('#unread').classList.remove('hidden');
}

function addSystem(text) {
  const el = document.createElement('div');
  el.className = 'msg system';
  el.textContent = text;
  appendToChat(el);
}

function appendToChat(el) {
  const log = $('#chatLog');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.appendChild(el);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

/* ---------------------------------------------------------------- configurações */

function switchRow(label, hint, checked, onChange) {
  const row = document.createElement('label');
  row.className = 'switch-row';
  const text = document.createElement('span');
  text.textContent = label;
  if (hint) {
    const s = document.createElement('small');
    s.textContent = hint;
    text.appendChild(s);
  }
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  row.append(text, input);
  return row;
}

function settingsSection(title) {
  const div = document.createElement('div');
  const h = document.createElement('h4');
  h.textContent = title;
  div.appendChild(h);
  return div;
}

function renderSettings() {
  const body = $('#settingsBody');
  body.innerHTML = '';

  // Perfil
  const prof = settingsSection('Seu perfil');
  const row = document.createElement('div');
  row.className = 'profile-row';
  const pick = document.createElement('button');
  pick.className = 'avatar-pick';
  pick.title = 'Trocar foto';
  pick.appendChild(avatarNode(state.name, state.avatar, 'xl'));
  pick.addEventListener('click', async () => {
    const a = await pickAvatar();
    if (a) { setAvatar(a); renderSettings(); }
  });
  const field = document.createElement('label');
  field.className = 'field grow';
  field.innerHTML = '<span>Nome</span>';
  const nameIn = document.createElement('input');
  nameIn.maxLength = 24;
  nameIn.value = state.name;
  field.appendChild(nameIn);
  const save = document.createElement('button');
  save.className = 'btn';
  save.textContent = 'Salvar';
  save.addEventListener('click', () => {
    state.name = cleanName(nameIn.value);
    savePref('name', state.name);
    $('#nameInput').value = state.name;
    broadcast({ t: 'profile', name: state.name, avatar: state.avatar });
    updatePeopleUI();
    toast('Perfil atualizado');
  });
  row.append(pick, field, save);
  prof.appendChild(row);
  if (state.avatar) {
    const rm = document.createElement('button');
    rm.className = 'link';
    rm.textContent = 'remover foto';
    rm.style.marginTop = '8px';
    rm.addEventListener('click', () => { setAvatar(''); renderSettings(); });
    prof.appendChild(rm);
  }
  body.appendChild(prof);

  // Preferências
  const prefs = settingsSection('Preferências');
  prefs.appendChild(switchRow('Sons de notificação', 'Quando alguém entra, sai ou manda mensagem.', state.sounds, (v) => {
    state.sounds = v;
    savePref('sounds', v ? '1' : '0');
    if (v) beep('chat');
  }));
  prefs.appendChild(switchRow('Ocultar minha prévia', 'Não mostra sua própria tela pra você. Economiza PC.', state.hidePreview, setHidePreview));
  prefs.appendChild(switchRow('Deixar os amigos apontarem na minha tela', 'Ponteiro, marcações e riscos em cima da tela que você compartilha.', state.annotAllow, (v) => {
    if (v !== state.annotAllow) toggleAnnotAllow();
  }));
  prefs.appendChild(switchRow('Permitir pedidos de controle da minha tela', 'Os amigos podem pedir pra usar seu mouse e teclado. Você sempre precisa aceitar, e Ctrl+Alt+X corta na hora.', state.ctrlAllow, toggleCtrlAllow));
  body.appendChild(prefs);

  // Cores do ponteiro e do desenho
  const colors = settingsSection('Ponteiro e desenho');
  const colorRow = (label, current, onPick) => {
    const wrap = document.createElement('div');
    wrap.className = 'color-row';
    const l = document.createElement('span');
    l.textContent = label;
    const sw = document.createElement('div');
    sw.className = 'swatches';
    const render = (cur) => {
      sw.innerHTML = '';
      for (const c of PALETTE) {
        const b = document.createElement('button');
        b.className = 'swatch' + (c.toLowerCase() === cur.toLowerCase() ? ' on' : '');
        b.style.background = c;
        b.title = c;
        b.addEventListener('click', () => { onPick(c); render(c); });
        sw.appendChild(b);
      }
      const custom = document.createElement('input');
      custom.type = 'color';
      custom.className = 'swatch-custom';
      custom.title = 'Outra cor';
      custom.value = cur;
      custom.addEventListener('change', () => { onPick(custom.value); render(custom.value); });
      sw.appendChild(custom);
    };
    render(current);
    wrap.append(l, sw);
    return wrap;
  };
  colors.appendChild(colorRow('Cor do seu ponteiro', myPtrColor(), setPtrColor));
  colors.appendChild(colorRow('Cor do seu desenho', myDrawColor(), (c) => setDrawColor(c)));
  const sizeRow = document.createElement('div');
  sizeRow.className = 'color-row';
  const sl = document.createElement('span');
  sl.textContent = 'Espessura do desenho';
  const sizes = document.createElement('div');
  sizes.className = 'swatches';
  const renderSizes = () => {
    sizes.innerHTML = '';
    ['Fino', 'Médio', 'Grosso'].forEach((name, i) => {
      const b = document.createElement('button');
      b.className = 'btn small' + (state.drawSize === i + 1 ? ' primary' : '');
      b.textContent = name;
      b.addEventListener('click', () => { setDrawSize(i + 1); renderSizes(); });
      sizes.appendChild(b);
    });
  };
  renderSizes();
  sizeRow.append(sl, sizes);
  colors.appendChild(sizeRow);
  body.appendChild(colors);

  // Regras da sala
  const rules = settingsSection(state.amHost ? 'Sala (você é o host)' : 'Regras da sala');
  const s = state.room.settings;
  if (state.amHost) {
    rules.appendChild(switchRow('Trancar sala', 'Ninguém novo entra (só você, se sair e voltar).', s.locked, (v) => updateRoom((r) => { r.settings.locked = v; })));
    rules.appendChild(switchRow('Só o host compartilha', 'Os outros só assistem.', s.onlyHost, (v) => updateRoom((r) => { r.settings.onlyHost = v; })));
    const tip = document.createElement('small');
    tip.className = 'muted';
    tip.textContent = 'Pra proibir ou remover alguém, clique no nome da pessoa na lista "Na sala".';
    rules.appendChild(tip);
    if (state.room.banned.length) {
      const h = document.createElement('h4');
      h.textContent = 'Removidos';
      rules.appendChild(h);
      const list = document.createElement('div');
      list.className = 'banned-list';
      for (const b of state.room.banned) {
        const r = document.createElement('div');
        r.className = 'row';
        const n = document.createElement('span');
        n.textContent = b.name;
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = 'Deixar voltar';
        btn.addEventListener('click', () => unban(b.clientId));
        r.append(n, btn);
        list.appendChild(r);
      }
      rules.appendChild(list);
    }
  } else {
    const p = document.createElement('p');
    p.className = 'muted';
    p.style.margin = '0';
    p.textContent = [
      s.locked ? 'A sala está trancada.' : 'A sala está aberta.',
      s.onlyHost ? 'Só o host pode compartilhar.' : canShareMe() ? 'Você pode compartilhar.' : 'O host proibiu você de compartilhar.',
      'Só o host muda essas regras.',
    ].join(' ');
    rules.appendChild(p);
  }
  body.appendChild(rules);

  // Conexão (TURN)
  const net = settingsSection('Conexão');
  const help = document.createElement('small');
  help.className = 'muted';
  help.textContent = state.amHost
    ? 'Se algum amigo não conseguir conectar (rede muito fechada), coloque aqui um servidor TURN (ex.: conta grátis na Metered ou Cloudflare). Como você é o host, ele é repassado pra todo mundo da sala.'
    : 'Se você não conseguir conectar com alguém (rede muito fechada), coloque aqui um servidor TURN (ex.: conta grátis na Metered ou Cloudflare).';
  net.appendChild(help);
  const mk = (ph, val, type = 'text') => {
    const i = document.createElement('input');
    i.placeholder = ph;
    i.value = val || '';
    i.type = type;
    i.autocomplete = 'off';
    i.spellcheck = false;
    return i;
  };
  const tu = mk('turn:servidor:3478', state.turn && state.turn.urls);
  const tn = mk('usuário', state.turn && state.turn.username);
  const tp = mk('senha', state.turn && state.turn.credential, 'password');
  const grid = document.createElement('div');
  grid.className = 'turn-grid';
  const tsave = document.createElement('button');
  tsave.className = 'btn';
  tsave.textContent = 'Salvar';
  tsave.addEventListener('click', () => {
    const raw = { urls: tu.value, username: tn.value, credential: tp.value };
    const t = raw.urls.trim() ? cleanTurn(raw) : null;
    if (raw.urls.trim() && !t) {
      toast('Endereço inválido. Use o formato turn:servidor:porta', 'error');
      return;
    }
    state.turn = t;
    savePref('turn', JSON.stringify(t));
    if (state.amHost) updateRoom((r) => { r.turn = t; });
    else applyRoomEffects();
    toast(t ? 'Servidor TURN salvo. Vale pras próximas conexões.' : 'Servidor TURN removido.');
  });
  grid.append(tu, tn, tp, tsave);
  net.appendChild(grid);
  if (state.room.turn && !state.amHost) {
    const info = document.createElement('small');
    info.className = 'muted';
    info.textContent = 'O host configurou um servidor TURN pra esta sala; ele já está sendo usado.';
    net.appendChild(info);
  }
  body.appendChild(net);

  // Sobre
  const about = settingsSection('Sobre');
  const v = document.createElement('small');
  v.className = 'muted';
  v.textContent = `Telinha Café ${state.appVersion}${state.portable ? ' (portátil)' : ''}. Todo mundo da sala precisa usar a mesma versão.`;
  about.appendChild(v);
  const donate = $('#donateBtn').cloneNode(true);
  donate.removeAttribute('id');
  donate.style.marginTop = '10px';
  donate.addEventListener('click', openDonate);
  about.appendChild(donate);
  body.appendChild(about);
}

// Abre o LivePix do Fate Café no navegador padrão (o app nunca navega pra fora).
function openDonate() {
  window.open(DONATE_URL, '_blank');
}

function openSettings() {
  renderSettings();
  $('#settings').classList.remove('hidden');
}
function closeSettings() {
  $('#settings').classList.add('hidden');
}

/* ---------------------------------------------------------------- seletor de tela */

const picker = { sources: [], tab: 'screen', selected: null, probe: null, mode: 'start', apps: [] };

async function openPicker(mode = 'start') {
  if (!canShareMe()) {
    toast('O host não permite que você compartilhe nesta sala.', 'error');
    return;
  }
  picker.mode = mode;
  picker.selected = null;
  picker.tab = 'screen';
  $('#pickerTitle').textContent = mode === 'switch' ? 'Trocar o que você compartilha' : 'Compartilhar';
  $('#pickerShare').textContent = mode === 'switch' ? 'Trocar' : 'Compartilhar';
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'screen'));
  $('#pickerShare').disabled = true;
  $('#sourceGrid').innerHTML = '<p class="muted">Carregando…</p>';
  $('#picker').classList.remove('hidden');

  if (!picker.probe) picker.probe = telinha.probeAudio();
  const [probe, sources] = await Promise.all([picker.probe, telinha.getSources()]);
  picker.probeOk = probe.ok;

  for (const id of ['#optNoDiscord', '#optApp']) {
    const opt = $(id);
    opt.querySelector('input').disabled = !probe.ok;
    opt.classList.toggle('disabled', !probe.ok);
  }
  $('#noDiscordHint').textContent = probe.ok
    ? 'Todo mundo ouve o PC, menos a call. Sem eco.'
    : 'Indisponível neste Windows (precisa de Windows 11 ou Windows 10 atualizado).';

  const prev = mode === 'switch' && state.screenSel ? state.screenSel : null;
  let audioMode = prev ? prev.audioMode : loadPref('audioMode', probe.ok ? 'nodiscord' : 'none');
  if ((audioMode === 'nodiscord' || audioMode === 'app') && !probe.ok) audioMode = 'none';
  document.querySelector(`input[name=audioMode][value=${audioMode}]`).checked = true;

  $('#qualitySelect').value = state.quality;
  updateQualityHint();

  picker.sources = sources;
  renderSources();
  loadAudioApps(prev && prev.appTarget);
}

async function loadAudioApps(keep) {
  const sel = $('#appSelect');
  const current = keep || sel.value;
  sel.innerHTML = '<option value="">Carregando…</option>';
  picker.apps = picker.probeOk ? await telinha.listAudioApps() : [];
  renderAppOptions(current);
}

function renderAppOptions(current) {
  const sel = $('#appSelect');
  const isWindow = picker.selected && picker.selected.startsWith('window:');
  sel.innerHTML = '';
  if (isWindow) {
    const o = document.createElement('option');
    o.value = 'window';
    o.textContent = 'Esta janela (o programa que você escolheu)';
    sel.appendChild(o);
  }
  const counts = {};
  for (const a of picker.apps) counts[a.name] = (counts[a.name] || 0) + 1;
  for (const a of picker.apps) {
    const o = document.createElement('option');
    o.value = String(a.pid);
    o.textContent = `${a.active ? '● ' : ''}${a.name}${counts[a.name] > 1 && a.exe ? ` (${a.exe})` : ''}`;
    sel.appendChild(o);
  }
  if (!sel.options.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'Nenhum app tocando som agora';
    sel.appendChild(o);
  }
  if (current && [...sel.options].some((o) => o.value === String(current))) sel.value = String(current);
  $('#appHint').textContent = '● = tocando som agora. Se o app não aparece, dê play nele e clique em ↻.';
}

function renderSources() {
  const grid = $('#sourceGrid');
  grid.innerHTML = '';
  const list = picker.sources.filter((s) => (picker.tab === 'screen') === s.isScreen);
  if (!list.length) {
    grid.innerHTML = '<p class="muted">Nada encontrado.</p>';
    return;
  }
  list.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'source';
    if (picker.selected === s.id) b.classList.add('selected');
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (s.thumb) thumb.style.backgroundImage = `url("${s.thumb}")`;
    const nm = document.createElement('div');
    nm.className = 'src-name';
    if (s.icon) {
      const img = document.createElement('img');
      img.src = s.icon;
      nm.appendChild(img);
    }
    const label = document.createElement('span');
    label.textContent = s.isScreen ? (list.length > 1 ? `Tela ${i + 1}` : 'Tela inteira') : s.name;
    label.title = s.name;
    nm.appendChild(label);
    b.append(thumb, nm);
    b.addEventListener('click', () => {
      picker.selected = s.id;
      grid.querySelectorAll('.source').forEach((x) => x.classList.remove('selected'));
      b.classList.add('selected');
      $('#pickerShare').disabled = false;
      renderAppOptions($('#appSelect').value || (s.id.startsWith('window:') ? 'window' : ''));
    });
    b.addEventListener('dblclick', () => {
      picker.selected = s.id;
      confirmPicker();
    });
    grid.appendChild(b);
  });
  if (picker.tab === 'screen' && list.length === 1 && !picker.selected) grid.firstChild.click();
}

function updateQualityHint() {
  const q = QUALITY[$('#qualitySelect').value];
  const viewers = [...state.peers.values()].filter((p) => p.helloed && !p.unsub.screen).length;
  const per = q.kbps / 1000;
  $('#qualityHint').textContent = viewers > 0
    ? `Usa ~${per} Mbps de upload por pessoa assistindo (${viewers} agora ≈ ${(per * viewers).toFixed(1)} Mbps).`
    : `Usa ~${per} Mbps de upload por pessoa assistindo.`;
}

function closePicker() {
  $('#picker').classList.add('hidden');
}

function confirmPicker() {
  if (!picker.selected) return;
  const audioMode = document.querySelector('input[name=audioMode]:checked').value;
  const appTarget = $('#appSelect').value;
  if (audioMode === 'app' && !appTarget) {
    toast('Escolha de qual app vai o som (ou outra opção de áudio).', 'error');
    return;
  }
  const quality = $('#qualitySelect').value;
  savePref('audioMode', audioMode);
  savePref('quality', quality);
  closePicker();
  const sel = { sourceId: picker.selected, audioMode, appTarget, quality };
  if (picker.mode === 'switch' && state.local.screen) {
    withBusy($('#switchBtn'), 'Trocando…', () => switchScreen(sel));
  } else {
    withBusy($('#screenBtn'), 'Iniciando…', () => startScreen(sel));
  }
}

/* ---------------------------------------------------------------- eventos */

async function init() {
  if (!PeerCtor) {
    setHomeStatus('Falha ao carregar o PeerJS.', true);
    return;
  }
  try {
    const info = await telinha.appInfo();
    state.appVersion = info.version;
    state.portable = info.portable;
  } catch {}
  $('#versionText').textContent = 'v' + state.appVersion;

  for (const sel of ['#qualitySelect', '#qualityLive']) {
    const el = $(sel);
    for (const [key, q] of Object.entries(QUALITY)) {
      const o = document.createElement('option');
      o.value = key;
      o.textContent = q.label;
      el.appendChild(o);
    }
  }
  if (!QUALITY[state.quality]) state.quality = '1080p60';
  state.avatar = cleanAvatar(state.avatar);

  const nameInput = $('#nameInput');
  nameInput.value = loadPref('name', '');
  nameInput.addEventListener('input', () => { if (!state.avatar) renderHomeAvatar(); });
  const codeInput = $('#codeInput');
  codeInput.value = loadPref('lastCode', '');
  codeInput.addEventListener('input', () => {
    const allowed = new Set(CODE_ALPHABET);
    codeInput.value = [...codeInput.value.toUpperCase()].filter((c) => allowed.has(c)).join('').slice(0, 6);
  });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') (codeInput.value ? joinRoom() : createRoom()); });
  $('#createBtn').addEventListener('click', createRoom);
  $('#joinBtn').addEventListener('click', joinRoom);
  $('#avatarBtn').addEventListener('click', async () => {
    const a = await pickAvatar();
    if (a) setAvatar(a);
  });
  $('#avatarRemove').addEventListener('click', () => setAvatar(''));
  $('#donateBtn').addEventListener('click', openDonate);
  renderHomeAvatar();
  renderRecentRooms();
  (nameInput.value ? codeInput : nameInput).focus();

  $('#codeBtn').addEventListener('click', async () => {
    await telinha.copy(state.code);
    toast('Código copiado!');
  });
  $('#screenBtn').addEventListener('click', () => (state.local.screen ? stopScreen() : openPicker('start')));
  $('#switchBtn').addEventListener('click', () => openPicker('switch'));
  $('#annotBtn').addEventListener('click', toggleAnnotAllow);
  $('#qualityLive').addEventListener('change', (e) => changeLiveQuality(e.target.value));
  $('#camBtn').addEventListener('click', () => (state.local.camera ? stopCamera() : withBusy($('#camBtn'), 'Abrindo…', () => startCamera(state.cameraId))));
  $('#camSelect').addEventListener('change', (e) => withBusy($('#camBtn'), 'Abrindo…', () => startCamera(e.target.value)));
  $('#chatBtn').addEventListener('click', () => {
    const side = $('#side');
    side.classList.toggle('collapsed');
    $('#chatBtn').classList.toggle('on', !side.classList.contains('collapsed'));
    if (!side.classList.contains('collapsed')) {
      $('#unread').classList.add('hidden');
      $('#chatInput').focus();
    }
    layoutGrid();
  });
  $('#chatBtn').classList.add('on');
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#settings').addEventListener('mousedown', (e) => { if (e.target.id === 'settings') closeSettings(); });
  $('#leaveBtn').addEventListener('click', () => leaveRoom());
  $('#ctrlAccept').addEventListener('click', () => answerCtrl(true));
  $('#ctrlDeny').addEventListener('click', () => answerCtrl(false));
  $('#ctrlBarStop').addEventListener('click', () => revokeControl(null, true));

  const bar = $('#reactBar');
  for (const emoji of REACTIONS) {
    const b = document.createElement('button');
    b.textContent = emoji;
    b.addEventListener('click', () => sendReaction(emoji));
    bar.appendChild(b);
  }
  $('#reactBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#personMenu').classList.add('hidden');
    bar.classList.toggle('hidden');
  });
  bar.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closeMenus);

  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text) return;
    broadcast({ t: 'chat', text });
    addChat(null, text, true);
    input.value = '';
  });

  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    picker.tab = b.dataset.tab;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    renderSources();
  }));
  $('#qualitySelect').addEventListener('change', updateQualityHint);
  $('#appSelect').addEventListener('change', () => { document.querySelector('input[name=audioMode][value=app]').checked = true; });
  $('#appRefresh').addEventListener('click', (e) => {
    e.preventDefault();
    loadAudioApps();
  });
  $('#pickerCancel').addEventListener('click', closePicker);
  $('#pickerShare').addEventListener('click', confirmPicker);
  $('#picker').addEventListener('mousedown', (e) => { if (e.target.id === 'picker') closePicker(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePicker();
      closeSettings();
      closeMenus();
      for (const t of tiles.values()) setDrawMode(t, false);
    }
  });

  window.addEventListener('beforeunload', () => {
    if (state.peer) {
      releaseDoor();
      broadcast({ t: 'bye' });
    }
    telinha.stopAudio();
    telinha.overlayHide();
  });

  // Já testa a captura de áudio em segundo plano, pro seletor abrir rápido.
  picker.probe = telinha.probeAudio();
}

init();
