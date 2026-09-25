'use strict';

// Camada transparente por cima do monitor compartilhado: desenha o que os amigos apontam
// e mostra avisos (pedido de controle / alguém controlando). Não aparece na transmissão.
const layer = new AnnotLayer(document.getElementById('c'));
const banner = document.getElementById('banner');

window.overlay.onAnnot((evt) => {
  if (evt && evt.type === 'banner') {
    banner.textContent = evt.text || '';
    banner.className = evt.text ? 'show ' + (evt.tone || '') : '';
    return;
  }
  layer.handle(evt);
});
