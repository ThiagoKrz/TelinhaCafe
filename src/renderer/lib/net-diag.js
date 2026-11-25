(function (root) {
  'use strict';

  function gatherCandidates(iceServers, timeoutMs = 4500) {
    return new Promise((resolve) => {
      const found = { host: [], srflx: [], relay: [] };
      const ports = new Set();
      let done = false;
      let pc = null;
      const finish = () => {
        if (done) return;
        done = true;
        try { if (pc) pc.close(); } catch {}
        resolve({ found, mappedPorts: ports.size });
      };
      try {
        pc = new RTCPeerConnection({ iceServers });
        pc.createDataChannel('diag');
        pc.onicecandidate = (e) => {
          if (!e.candidate) { finish(); return; }
          const c = e.candidate.candidate || '';
          const type = (/ typ (\w+)/.exec(c) || [])[1];
          const parts = c.split(' ');
          const port = parts[5];
          if (type && found[type]) found[type].push(c);
          if (type === 'srflx' && port) ports.add(port);
        };
        pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(finish);
      } catch {
        finish();
      }
      setTimeout(finish, timeoutMs);
    });
  }

  async function probeSignalServer(signalServer) {
    const host = (signalServer && signalServer.host) || '0.peerjs.com';
    const port = (signalServer && signalServer.port) || 443;
    const secure = signalServer ? signalServer.secure : true;
    const path = (signalServer && signalServer.path) || '/';
    const proto = secure ? 'https' : 'http';
    const defPort = (secure && port === 443) || (!secure && port === 80);
    const base = `${proto}://${host}${defPort ? '' : ':' + port}${path.replace(/\/$/, '')}`;
    const t0 = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(base + '/', { signal: ctrl.signal, cache: 'no-store' });
      const ms = Math.round(performance.now() - t0);
      return { ok: res.ok || res.status < 500, status: res.status, ms, host };
    } catch (e) {
      return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'falhou', ms: null, host };
    } finally {
      clearTimeout(timer);
    }
  }

  async function runNetworkDiagnostic({ iceServers, signalServer, onStep } = {}) {
    const log = (msg) => { if (typeof onStep === 'function') onStep(msg); };
    const stunOnly = (iceServers || []).filter((s) => {
      const u = Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls || '');
      return /stun:/i.test(u);
    });
    const turnOnly = (iceServers || []).filter((s) => {
      const u = Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls || '');
      return /turns?:/i.test(u);
    });

    log('Testando servidor de salas…');
    const signal = await probeSignalServer(signalServer);

    log('Testando sua rede (STUN / NAT)…');
    const stun = await gatherCandidates(stunOnly.length ? stunOnly : [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }]);

    let turn = null;
    if (turnOnly.length) {
      log('Testando servidor TURN configurado…');
      const r = await gatherCandidates(turnOnly, 5500);
      turn = { ok: r.found.relay.length > 0, relays: r.found.relay.length };
    }

    let nat = 'desconhecido';
    let tone = 'ok';
    let summary = '';
    if (!signal.ok) {
      tone = 'bad';
      summary = `Sem resposta do servidor de salas (${signal.host}). Verifique sua internet ou tente outro servidor de sinalização.`;
    } else if (stun.found.srflx.length === 0) {
      nat = 'bloqueado';
      tone = 'bad';
      summary = 'Sua rede bloqueou UDP/STUN. Conexão direta P2P provavelmente não vai abrir sem VPN (Radmin/ZeroTier) ou TURN.';
    } else if (stun.mappedPorts > 1) {
      nat = 'simétrico (CGNAT rígido)';
      tone = turn && turn.ok ? 'ok' : 'warn';
      summary = turn && turn.ok
        ? 'Sua rede usa NAT simétrico, mas o servidor TURN respondeu certinho — a conexão vai funcionar via servidor.'
        : 'Sua rede usa NAT simétrico / CGNAT rígido. Com amigos de rede tranquila pode conectar; entre dois CGNAT rígidos vai precisar de TURN ou Radmin VPN.';
    } else {
      nat = 'tranquilo (Cone)';
      tone = 'ok';
      summary = 'Sua rede está ótima para conexão direta P2P!';
    }

    if (turn && !turn.ok) {
      tone = 'warn';
      summary += ' Atenção: o servidor TURN configurado não respondeu (confira endereço, usuário e senha).';
    }

    return { signal, nat, mappedPorts: stun.mappedPorts, hasSrflx: stun.found.srflx.length > 0, turn, tone, summary };
  }

  const api = { runNetworkDiagnostic, probeSignalServer };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TelinhaLib = Object.assign(root.TelinhaLib || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : window);
