(function (root) {
  'use strict';

  // Extrai telemetria real de uma RTCPeerConnection (outbound ou inbound).
  async function collectPcStats(pc, prev = null) {
    if (!pc || typeof pc.getStats !== 'function') return null;
    try {
      const report = await pc.getStats();
      const codecs = new Map();
      const candidates = new Map();
      let activePair = null;
      let outVideo = null;
      let inVideo = null;

      report.forEach((s) => {
        if (s.type === 'codec') codecs.set(s.id, s);
        else if (s.type === 'local-candidate' || s.type === 'remote-candidate') candidates.set(s.id, s);
        else if (s.type === 'candidate-pair' && (s.nominated || s.state === 'succeeded')) {
          if (!activePair || s.nominated) activePair = s;
        } else if (s.type === 'outbound-rtp' && s.kind === 'video' && !s.isRemote) {
          outVideo = s;
        } else if (s.type === 'inbound-rtp' && s.kind === 'video' && !s.isRemote) {
          inVideo = s;
        }
      });

      const v = outVideo || inVideo;
      const now = v ? v.timestamp : performance.now();
      const bytes = outVideo ? (outVideo.bytesSent || 0) : (inVideo ? (inVideo.bytesReceived || 0) : 0);
      let kbps = 0;
      if (prev && prev.ts && now > prev.ts && bytes >= prev.bytes) {
        kbps = Math.round(((bytes - prev.bytes) * 8) / (now - prev.ts));
      }

      const codecRec = v && v.codecId ? codecs.get(v.codecId) : null;
      const codec = codecRec && codecRec.mimeType ? codecRec.mimeType.replace(/^video\//i, '') : '';

      let route = 'direto';
      let rttMs = null;
      if (activePair) {
        if (typeof activePair.currentRoundTripTime === 'number') {
          rttMs = Math.round(activePair.currentRoundTripTime * 1000);
        }
        const loc = candidates.get(activePair.localCandidateId);
        const rem = candidates.get(activePair.remoteCandidateId);
        if ((loc && loc.candidateType === 'relay') || (rem && rem.candidateType === 'relay')) {
          route = 'via servidor';
        }
      }

      let lossPct = 0;
      if (inVideo && typeof inVideo.packetsLost === 'number' && typeof inVideo.packetsReceived === 'number') {
        const prevLost = prev ? (prev.packetsLost || 0) : 0;
        const prevRecv = prev ? (prev.packetsReceived || 0) : 0;
        const dLost = Math.max(0, inVideo.packetsLost - prevLost);
        const dRecv = Math.max(0, inVideo.packetsReceived - prevRecv);
        const total = dLost + dRecv;
        if (total > 0) lossPct = Math.round((dLost / total) * 1000) / 10;
      }

      const snapshot = {
        ts: now,
        bytes,
        packetsLost: inVideo ? (inVideo.packetsLost || 0) : 0,
        packetsReceived: inVideo ? (inVideo.packetsReceived || 0) : 0,
      };

      return {
        direction: outVideo ? 'out' : (inVideo ? 'in' : 'none'),
        kbps,
        fps: v && typeof v.framesPerSecond === 'number' ? Math.round(v.framesPerSecond) : 0,
        width: v ? (v.frameWidth || 0) : 0,
        height: v ? (v.frameHeight || 0) : 0,
        codec,
        route,
        rttMs,
        lossPct,
        limitedBy: outVideo && outVideo.qualityLimitationReason ? outVideo.qualityLimitationReason : 'none',
        snapshot,
      };
    } catch {
      return null;
    }
  }

  // Detecta gargalo sustentado de upload ao transmitir tela e dispara alerta uma vez por janela.
  class UploadHealthMonitor {
    constructor(opts = {}) {
      this.thresholdCount = opts.thresholdCount || 4; // ~8s com amostragem a cada 2s
      this.cooldownMs = opts.cooldownMs || 60000;
      this.streak = 0;
      this.lastAlertAt = -Infinity;
    }

    reset() {
      this.streak = 0;
    }

    sample(statsList, now = Date.now()) {
      if (!Array.isArray(statsList) || !statsList.length) {
        this.streak = 0;
        return null;
      }
      const congested = statsList.some((s) => s && s.direction === 'out' && s.limitedBy === 'bandwidth');
      if (congested) this.streak += 1;
      else this.streak = Math.max(0, this.streak - 1);

      if (this.streak >= this.thresholdCount && now - this.lastAlertAt >= this.cooldownMs) {
        this.lastAlertAt = now;
        this.streak = 0;
        const avgKbps = Math.round(statsList.reduce((a, s) => a + (s.kbps || 0), 0) / statsList.length);
        return { reason: 'bandwidth', avgKbps, peers: statsList.length };
      }
      return null;
    }
  }

  const api = { collectPcStats, UploadHealthMonitor };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TelinhaLib = Object.assign(root.TelinhaLib || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : window);
