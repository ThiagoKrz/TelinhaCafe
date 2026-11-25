(function (root) {
  'use strict';

  const URL_RE = /(https?:\/\/[^\s<>"']+)/gi;

  function splitChatLinks(text) {
    const src = String(text || '');
    const parts = [];
    let last = 0;
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(src)) !== null) {
      if (m.index > last) parts.push({ type: 'text', value: src.slice(last, m.index) });
      parts.push({ type: 'link', value: m[0] });
      last = m.index + m[0].length;
    }
    if (last < src.length) parts.push({ type: 'text', value: src.slice(last) });
    return parts;
  }

  function isValidChatImage(dataUrl) {
    return typeof dataUrl === 'string'
      && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)
      && dataUrl.length < 220000;
  }

  const api = { splitChatLinks, isValidChatImage };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TelinhaLib = Object.assign(root.TelinhaLib || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : window);
