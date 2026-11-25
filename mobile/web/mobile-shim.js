'use strict';

// No Android não existe o processo principal do Electron: esta ponte oferece a mesma API
// (window.telinha) que o preload do PC, com o que só existe no Windows desligado
// (captura de áudio por programa, camada por cima da tela, receber controle remoto).
(function () {
  const noop = () => {};
  const resolved = (v) => () => Promise.resolve(v);

  window.telinha = {
    platform: 'android',
    appInfo: resolved({ version: '__APP_VERSION__', portable: false }),
    getSources: resolved([]),
    selectSource: resolved(false),
    probeAudio: resolved({ ok: false, error: 'Indisponível no celular.' }),
    listAudioApps: resolved([]),
    startAudio: resolved({ ok: false, error: 'Indisponível no celular.' }),
    stopAudio: resolved(true),
    overlayShow: resolved(false),
    overlayHide: resolved(true),
    overlayEvent: noop,
    controlStart: resolved({ ok: false, error: 'O celular não pode ser controlado.' }),
    controlInput: noop,
    controlStop: resolved(true),
    controlPending: resolved(true),
    onControlShortcut: noop,
    onControlEnded: noop,
    onAudioData: noop,
    onAudioStatus: noop,
    onDeepLink(cb) {
      window.__telinhaDeepLinkCb = cb;
      if (window.__telinhaPendingCode) {
        const c = window.__telinhaPendingCode;
        window.__telinhaPendingCode = null;
        cb(c);
      }
    },
    async readClipboard() {
      try { return (await navigator.clipboard.readText()) || ''; } catch { return ''; }
    },
    async copyImage(dataUrl) {
      try {
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = 'telinha-print.png';
        a.click();
        return true;
      } catch { return false; }
    },

    async copy(text) {
      try {
        await navigator.clipboard.writeText(String(text));
      } catch {
        const ta = document.createElement('textarea');
        ta.value = String(text);
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      return true;
    },

    // Links externos (ex.: LivePix) abrem no navegador do celular: o Capacitor manda
    // qualquer navegação pra fora do app pro navegador padrão.
    openExternal(url) {
      if (/^https:\/\//.test(url)) window.location.href = url;
    },
    onUpdateProgress: noop,
    async checkUpdate() {
      const current = '__APP_VERSION__';
      try {
        const res = await fetch('https://api.github.com/repos/ThiagoKrz/TelinhaCafe/releases/latest', {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!res.ok) return { ok: false, error: 'HTTP ' + res.status, current };
        const data = await res.json();
        const latest = String(data.tag_name || '').replace(/^v/i, '');
        const pa = latest.split('.').map(Number);
        const pb = current.split('.').map(Number);
        let cmp = 0;
        for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) { cmp = (pa[i] || 0) - (pb[i] || 0); break; } }
        const assets = Array.isArray(data.assets) ? data.assets : [];
        const apk = assets.find((a) => /\.apk$/i.test(a.name || ''));
        return {
          ok: true,
          hasUpdate: cmp > 0,
          current,
          latest: latest || current,
          releaseUrl: data.html_url || 'https://github.com/ThiagoKrz/TelinhaCafe/releases/latest',
          downloadUrl: apk ? apk.browser_download_url : null,
          assetName: apk ? apk.name : null,
          canAutoInstall: false,
        };
      } catch (e) {
        return { ok: false, error: (e && e.message) || 'falhou', current };
      }
    },
    async installUpdate(info = {}) {
      const target = info.downloadUrl || info.releaseUrl || 'https://github.com/ThiagoKrz/TelinhaCafe/releases/latest';
      if (/^https:\/\//.test(target)) window.location.href = target;
      return { ok: true, openedBrowser: true };
    },

    // Compartilhamento de tela nativo no Android (MediaProjection -> canvas.captureStream).
    async mobileScreenStart(onStopped) {
      const cap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ScreenShare;
      if (!cap) throw new Error('Plugin de captura de tela indisponível.');
      const res = await cap.start({ maxSide: 720, fps: 18, quality: 72 });
      const canvas = document.createElement('canvas');
      canvas.width = res.width || 720;
      canvas.height = res.height || 1280;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#171210';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let busy = false;
      const frameHandle = await cap.addListener('frame', (ev) => {
        if (busy || !ev || !ev.data) return;
        busy = true;
        const img = new Image();
        img.onload = () => {
          if (ev.width && ev.height && (canvas.width !== ev.width || canvas.height !== ev.height)) {
            canvas.width = ev.width;
            canvas.height = ev.height;
          }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          busy = false;
        };
        img.onerror = () => { busy = false; };
        img.src = ev.data;
      });
      const stopHandle = await cap.addListener('stopped', () => {
        if (typeof onStopped === 'function') onStopped();
      });

      const stream = canvas.captureStream(18);
      window.__mobileScreenCleanup = async () => {
        try { await frameHandle.remove(); } catch {}
        try { await stopHandle.remove(); } catch {}
        try { await cap.stop(); } catch {}
      };
      return stream;
    },

    async mobileScreenStop() {
      const fn = window.__mobileScreenCleanup;
      window.__mobileScreenCleanup = null;
      if (fn) await fn();
    },
  };

  window.__telinhaDeepLink = (code) => {
    if (typeof window.__telinhaDeepLinkCb === 'function') window.__telinhaDeepLinkCb(code);
    else window.__telinhaPendingCode = code;
  };

  document.documentElement.classList.add('mobile');
})();
