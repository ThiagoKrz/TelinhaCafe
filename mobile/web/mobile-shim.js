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
  };

  document.documentElement.classList.add('mobile');
})();
