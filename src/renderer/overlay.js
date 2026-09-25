'use strict';

// Camada transparente por cima do monitor compartilhado: só desenha o que os amigos apontam.
const layer = new AnnotLayer(document.getElementById('c'));
window.overlay.onAnnot((evt) => layer.handle(evt));
