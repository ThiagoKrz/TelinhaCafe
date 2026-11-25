(function (root) {
  'use strict';

  const PREFIX = 'telinha.';
  const mem = new Map();

  function storage() {
    try {
      return root.localStorage || null;
    } catch {
      return null;
    }
  }

  function loadPref(key, def = '') {
    const full = PREFIX + key;
    const st = storage();
    if (st) {
      try {
        const v = st.getItem(full);
        if (v !== null) {
          mem.set(full, v);
          return v;
        }
      } catch {}
    }
    return mem.has(full) ? mem.get(full) : def;
  }

  function savePref(key, val) {
    const full = PREFIX + key;
    const str = String(val);
    mem.set(full, str);
    const st = storage();
    if (st) {
      try {
        st.setItem(full, str);
        return true;
      } catch {}
    }
    return false;
  }

  function removePref(key) {
    const full = PREFIX + key;
    mem.delete(full);
    const st = storage();
    if (st) {
      try { st.removeItem(full); } catch {}
    }
  }

  function loadJsonPref(key, def = null, validate = null) {
    const raw = loadPref(key, '');
    if (!raw) return def;
    try {
      const parsed = JSON.parse(raw);
      return typeof validate === 'function' ? validate(parsed) : parsed;
    } catch {
      return def;
    }
  }

  function saveJsonPref(key, val) {
    try {
      return savePref(key, JSON.stringify(val));
    } catch {
      return false;
    }
  }

  function getClientId() {
    let id = loadPref('clientId', '');
    if (!/^[a-f0-9]{32}$/.test(id)) {
      const bytes = new Uint8Array(16);
      if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(bytes);
      else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      savePref('clientId', id);
    }
    return id;
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

  const api = {
    loadPref,
    savePref,
    removePref,
    loadJsonPref,
    saveJsonPref,
    getClientId,
    cleanName,
    cleanAvatar,
    cmpVersion,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TelinhaLib = Object.assign(root.TelinhaLib || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : window);
