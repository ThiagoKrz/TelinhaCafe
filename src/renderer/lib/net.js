(function (root) {
  'use strict';

  const DEFAULT_ICE = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  ];

  const BLOCKED_HELP = 'Dica: todos entrarem na mesma rede do Radmin VPN (ou ZeroTier/Tailscale) resolve na hora; ou o host configura um servidor TURN em ⚙ Configurações → Avançado.';

  const ANSWER_ICE_DELAY_MS = 3000;

  // Ordem com uma pessoa: 'me' = eu bato primeiro, 'them' = ela bate primeiro.
  const flipFirst = (first) => (first === 'me' ? 'them' : 'me');
  // Pedido que vai junto da conexão: 'o' = quem responde espera (eu, que peço, bato primeiro).
  const iceFlag = (first) => (first === 'me' ? 'o' : 'a');
  // Do lado de quem responde: espero? Sem pedido (versão antiga), uso o que já sei; senão espero.
  function answerWaits(md, known) {
    if (md && md.ice === 'o') return true;
    if (md && md.ice === 'a') return false;
    return known ? known === 'them' : true;
  }

  function cleanTurn(t) {
    if (!t || typeof t !== 'object') return null;
    const urls = String(t.urls || '').trim();
    if (!/^turns?:[^\s]{3,200}$/.test(urls)) return null;
    return {
      urls,
      username: String(t.username || '').slice(0, 200),
      credential: String(t.credential || '').slice(0, 200),
    };
  }

  // Servidor de sinalização PeerJS customizado (ou null para usar o padrão 0.peerjs.com).
  // Aceita objeto { host, port, path, secure, key } ou string URL ("https://meu-peer.com:443/peerjs").
  function cleanSignalServer(input) {
    if (!input) return null;
    if (typeof input === 'string') {
      const raw = input.trim();
      if (!raw) return null;
      try {
        const hasScheme = /^[a-z]+:\/\//i.test(raw);
        const u = new URL(hasScheme ? raw : 'https://' + raw);
        if (!u.hostname || u.hostname.length > 200) return null;
        const secure = u.protocol !== 'http:' && u.protocol !== 'ws:';
        const port = u.port ? Number(u.port) : (secure ? 443 : 80);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
        return {
          host: u.hostname,
          port,
          path: u.pathname && u.pathname !== '' ? u.pathname : '/',
          secure,
          key: 'peerjs',
        };
      } catch {
        return null;
      }
    }
    if (typeof input !== 'object') return null;
    const host = String(input.host || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!host || !/^[a-z0-9.-]{3,200}$/i.test(host)) return null;
    const secure = input.secure !== false;
    const port = Number(input.port) || (secure ? 443 : 80);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    let path = String(input.path || '/').trim();
    if (!path.startsWith('/')) path = '/' + path;
    const key = String(input.key || 'peerjs').trim().slice(0, 64) || 'peerjs';
    return { host, port, path, secure, key };
  }

  function formatSignalServer(s) {
    if (!s) return '';
    const proto = s.secure ? 'https' : 'http';
    const defPort = (s.secure && s.port === 443) || (!s.secure && s.port === 80);
    const portPart = defPort ? '' : ':' + s.port;
    const pathPart = s.path && s.path !== '/' ? s.path : '';
    return `${proto}://${s.host}${portPart}${pathPart}`;
  }

  function buildPeerOptions(iceServers, signalServer) {
    const opts = { debug: 1, config: { iceServers } };
    if (signalServer) {
      opts.host = signalServer.host;
      opts.port = signalServer.port;
      opts.path = signalServer.path;
      opts.secure = signalServer.secure;
      if (signalServer.key) opts.key = signalServer.key;
    }
    return opts;
  }

  function backoffDelay(attempt, baseMs = 1500, maxMs = 15000) {
    const exp = Math.min(maxMs, baseMs * Math.pow(1.8, Math.max(0, attempt)));
    return Math.round(exp * (0.85 + Math.random() * 0.3));
  }

  const api = {
    DEFAULT_ICE,
    BLOCKED_HELP,
    ANSWER_ICE_DELAY_MS,
    flipFirst,
    iceFlag,
    answerWaits,
    cleanTurn,
    cleanSignalServer,
    formatSignalServer,
    buildPeerOptions,
    backoffDelay,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TelinhaLib = Object.assign(root.TelinhaLib || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : window);
