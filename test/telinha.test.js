'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const prefs = require('../src/renderer/lib/prefs.js');
const keymap = require('../src/renderer/lib/keymap.js');
const net = require('../src/renderer/lib/net.js');
const stats = require('../src/renderer/lib/stats.js');

test('prefs: memória segura, JSON corrompido e sanitização', () => {
  prefs.savePref('testKey', 'valor123');
  assert.equal(prefs.loadPref('testKey', 'def'), 'valor123');
  prefs.removePref('testKey');
  assert.equal(prefs.loadPref('testKey', 'def'), 'def');

  prefs.savePref('brokenJson', '{invalido');
  assert.deepEqual(prefs.loadJsonPref('brokenJson', { ok: true }), { ok: true });

  prefs.saveJsonPref('goodJson', { a: 1 });
  assert.deepEqual(prefs.loadJsonPref('goodJson', null), { a: 1 });

  const cid = prefs.getClientId();
  assert.match(cid, /^[a-f0-9]{32}$/);
  assert.equal(prefs.getClientId(), cid);

  assert.equal(prefs.cleanName('   Thiago   Krz  '), 'Thiago Krz');
  assert.equal(prefs.cleanName('   '), 'Amigo');
  assert.equal(prefs.cleanAvatar('javascript:alert(1)'), '');
  assert.equal(prefs.cmpVersion('1.3.2', '1.3.0') > 0, true);
  assert.equal(prefs.cmpVersion('1.3.0', '1.4.0') < 0, true);
  assert.equal(prefs.cmpVersion('1.3.2', '1.3.2'), 0);
});

test('keymap: SCANCODES sem tecla Windows e acentos ABNT2', () => {
  assert.equal(keymap.SCANCODES.MetaLeft, undefined);
  assert.equal(keymap.SCANCODES.MetaRight, undefined);
  assert.deepEqual(keymap.SCANCODES.KeyA, [0x1e, 0]);
  assert.deepEqual(keymap.SCANCODES.ArrowUp, [0x48, 1]);

  assert.deepEqual(keymap.charToKeys('a'), [['KeyA', false]]);
  assert.deepEqual(keymap.charToKeys('A'), [['KeyA', true]]);
  assert.deepEqual(keymap.charToKeys('ç'), [['Semicolon', false]]);
  assert.deepEqual(keymap.charToKeys('á'), [['BracketLeft', false], ['KeyA', false]]);
  assert.deepEqual(keymap.charToKeys('ã'), [['Quote', false], ['KeyA', false]]);
  assert.deepEqual(keymap.charToKeys('É'), [['BracketLeft', false], ['KeyE', true]]);
});

test('net: ordem ICE, TURN, servidor de sinalização e backoff', () => {
  assert.equal(net.flipFirst('me'), 'them');
  assert.equal(net.flipFirst('them'), 'me');
  assert.equal(net.iceFlag('me'), 'o');
  assert.equal(net.iceFlag('them'), 'a');
  assert.equal(net.answerWaits({ ice: 'o' }, null), true);
  assert.equal(net.answerWaits({ ice: 'a' }, null), false);

  assert.deepEqual(net.cleanTurn({ urls: 'turn:exemplo.com:3478', username: 'u', credential: 'p' }), {
    urls: 'turn:exemplo.com:3478',
    username: 'u',
    credential: 'p',
  });
  assert.equal(net.cleanTurn({ urls: 'http://invalido' }), null);

  const sig = net.cleanSignalServer('https://peer.meusite.com:8443/telinha');
  assert.deepEqual(sig, { host: 'peer.meusite.com', port: 8443, path: '/telinha', secure: true, key: 'peerjs' });
  assert.equal(net.formatSignalServer(sig), 'https://peer.meusite.com:8443/telinha');
  assert.equal(net.cleanSignalServer(''), null);

  const opts = net.buildPeerOptions(net.DEFAULT_ICE, sig);
  assert.equal(opts.host, 'peer.meusite.com');
  assert.equal(opts.port, 8443);
  assert.equal(opts.path, '/telinha');
  assert.equal(opts.secure, true);

  const d0 = net.backoffDelay(0, 1000, 10000);
  const d3 = net.backoffDelay(3, 1000, 10000);
  assert.ok(d0 >= 800 && d0 <= 1400);
  assert.ok(d3 > d0 && d3 <= 12000);
});

test('stats: collectPcStats e UploadHealthMonitor', async () => {
  const fakeReport = new Map([
    ['c1', { id: 'c1', type: 'codec', mimeType: 'video/H264' }],
    ['lc1', { id: 'lc1', type: 'local-candidate', candidateType: 'relay' }],
    ['rc1', { id: 'rc1', type: 'remote-candidate', candidateType: 'srflx' }],
    ['cp1', { id: 'cp1', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1', remoteCandidateId: 'rc1', currentRoundTripTime: 0.042 }],
    ['out1', { id: 'out1', type: 'outbound-rtp', kind: 'video', isRemote: false, timestamp: 2000, bytesSent: 500000, framesPerSecond: 60, frameWidth: 1920, frameHeight: 1080, codecId: 'c1', qualityLimitationReason: 'bandwidth' }],
  ]);
  const pc = { getStats: async () => fakeReport };
  const res = await stats.collectPcStats(pc, { ts: 1000, bytes: 0 });
  assert.equal(res.direction, 'out');
  assert.equal(res.kbps, 4000);
  assert.equal(res.fps, 60);
  assert.equal(res.codec, 'H264');
  assert.equal(res.route, 'via servidor');
  assert.equal(res.rttMs, 42);
  assert.equal(res.limitedBy, 'bandwidth');

  const mon = new stats.UploadHealthMonitor({ thresholdCount: 3, cooldownMs: 60000 });
  assert.equal(mon.sample([res], 1000), null);
  assert.equal(mon.sample([res], 3000), null);
  const alert = mon.sample([res], 5000);
  assert.ok(alert && alert.reason === 'bandwidth');
  // Cooldown impede spam imediato
  assert.equal(mon.sample([res], 7000), null);
  assert.equal(mon.sample([res], 9000), null);
  assert.equal(mon.sample([res], 11000), null);
});

test('annot: balão de chat no ponteiro, controle remoto e clamp na borda', () => {
  const annotPath = path.join(__dirname, '..', 'src', 'renderer', 'annot.js');
  let calls = [];
  const ctx = {
    window: { devicePixelRatio: 1 },
    performance: { now: () => 1000 },
    requestAnimationFrame: () => 1,
  };
  vm.runInNewContext(fs.readFileSync(annotPath, 'utf8'), ctx);
  const g = {
    setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
    moveTo() {}, lineTo() {},
    roundRect(...a) { calls.push(['roundRect', ...a]); },
    fillText(...a) { calls.push(['fillText', ...a]); },
    measureText: (s) => ({ width: s.length * 7 }),
  };
  const canvas = { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720, getContext: () => g };
  const layer = new ctx.window.AnnotLayer(canvas);

  layer.handle({ type: 'ptr', from: 'p1', name: 'Thiago', color: '#D4A373', x: 0.5, y: 0.5 });
  layer.handle({ type: 'chat', from: 'p1', name: 'Thiago', text: 'clica ali' });
  layer.draw();
  assert.ok(calls.some((c) => c[0] === 'fillText' && String(c[1]).includes('clica ali')));

  calls = [];
  layer.handle({ type: 'ptr', from: 'p1', x: null });
  layer.handle({ type: 'chat', from: 'p1', name: 'Thiago', text: 'no botão verde' });
  layer.draw();
  assert.ok(calls.some((c) => c[0] === 'fillText' && String(c[1]).includes('clica ali')));
  assert.ok(calls.some((c) => c[0] === 'fillText' && String(c[1]).includes('no botão verde')));

  calls = [];
  layer.handle({ type: 'ctrl-ptr', from: 'p2', name: 'Ana', color: '#86C07A', x: 0.99, y: 0.01 });
  layer.handle({ type: 'chat', from: 'p2', name: 'Ana', text: 'abrindo configs' });
  layer.draw();
  const rect = calls.filter((c) => c[0] === 'roundRect').pop();
  assert.ok(rect[1] >= 0 && rect[1] + rect[3] <= 1280);
  assert.ok(rect[2] >= 0 && rect[2] + rect[4] <= 720);

  calls = [];
  layer.clear();
  layer.handle({ type: 'chat', from: 'p3', name: 'Bia', text: 'oi' });
  layer.draw();
  assert.equal(calls.some((c) => c[0] === 'fillText'), false);
});
