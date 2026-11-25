(function (root) {
  'use strict';

  // Teclas permitidas (KeyboardEvent.code -> [scancode, estendida]). Posicional: funciona com
  // qualquer layout (ABNT2 incluso). A tecla Windows fica de fora de propósito.
  const SCANCODES = (() => {
    const m = {};
    const row = (codes, start) => codes.forEach((c, i) => { m[c] = [start + i, 0]; });
    row(['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight'], 0x10);
    row(['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote', 'Backquote'], 0x1e);
    row(['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'], 0x2c);
    row(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal', 'Backspace', 'Tab'], 0x02);
    row(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'], 0x3b);
    Object.assign(m, {
      Escape: [0x01, 0], Enter: [0x1c, 0], ControlLeft: [0x1d, 0], ShiftLeft: [0x2a, 0], Backslash: [0x2b, 0],
      ShiftRight: [0x36, 0], NumpadMultiply: [0x37, 0], AltLeft: [0x38, 0], Space: [0x39, 0], CapsLock: [0x3a, 0],
      NumLock: [0x45, 0], ScrollLock: [0x46, 0], Numpad7: [0x47, 0], Numpad8: [0x48, 0], Numpad9: [0x49, 0],
      NumpadSubtract: [0x4a, 0], Numpad4: [0x4b, 0], Numpad5: [0x4c, 0], Numpad6: [0x4d, 0], NumpadAdd: [0x4e, 0],
      Numpad1: [0x4f, 0], Numpad2: [0x50, 0], Numpad3: [0x51, 0], Numpad0: [0x52, 0], NumpadDecimal: [0x53, 0],
      IntlBackslash: [0x56, 0], F11: [0x57, 0], F12: [0x58, 0], IntlRo: [0x73, 0], NumpadComma: [0x7e, 0],
      NumpadEnter: [0x1c, 1], ControlRight: [0x1d, 1], NumpadDivide: [0x35, 1], AltRight: [0x38, 1],
      Home: [0x47, 1], ArrowUp: [0x48, 1], PageUp: [0x49, 1], ArrowLeft: [0x4b, 1], ArrowRight: [0x4d, 1],
      End: [0x4f, 1], ArrowDown: [0x50, 1], PageDown: [0x51, 1], Insert: [0x52, 1], Delete: [0x53, 1], ContextMenu: [0x5d, 1],
    });
    return m;
  })();

  // Texto digitado no teclado do celular -> teclas no PC (layout ABNT2).
  const ABNT2_CHARS = (() => {
    const m = {};
    for (let c = 97; c <= 122; c++) {
      const ch = String.fromCharCode(c);
      m[ch] = [['Key' + ch.toUpperCase(), false]];
      m[ch.toUpperCase()] = [['Key' + ch.toUpperCase(), true]];
    }
    for (let d = 0; d <= 9; d++) m[String(d)] = [['Digit' + d, false]];
    const put = (ch, code, shift = false) => { m[ch] = [[code, shift]]; };
    put(' ', 'Space'); put('\n', 'Enter');
    put('!', 'Digit1', true); put('@', 'Digit2', true); put('#', 'Digit3', true); put('$', 'Digit4', true);
    put('%', 'Digit5', true); put('&', 'Digit7', true); put('*', 'Digit8', true); put('(', 'Digit9', true); put(')', 'Digit0', true);
    put('-', 'Minus'); put('_', 'Minus', true); put('=', 'Equal'); put('+', 'Equal', true);
    put(',', 'Comma'); put('<', 'Comma', true); put('.', 'Period'); put('>', 'Period', true);
    put(';', 'Slash'); put(':', 'Slash', true); put('/', 'IntlRo'); put('?', 'IntlRo', true);
    put("'", 'Backquote'); put('"', 'Backquote', true);
    put('ç', 'Semicolon'); put('Ç', 'Semicolon', true);
    put('[', 'BracketRight'); put('{', 'BracketRight', true); put(']', 'Backslash'); put('}', 'Backslash', true);
    put('\\', 'IntlBackslash'); put('|', 'IntlBackslash', true);
    return m;
  })();

  // Tecla morta de cada acento no ABNT2: ´ ` ~ ^ ¨
  const ABNT2_DEAD = {
    '\u0301': ['BracketLeft', false],
    '\u0300': ['BracketLeft', true],
    '\u0303': ['Quote', false],
    '\u0302': ['Quote', true],
    '\u0308': ['Digit6', true],
  };

  function charToKeys(ch) {
    if (ABNT2_CHARS[ch]) return ABNT2_CHARS[ch];
    const [base, mark] = ch.normalize('NFD');
    if (mark && ABNT2_DEAD[mark] && ABNT2_CHARS[base]) return [ABNT2_DEAD[mark], ...ABNT2_CHARS[base]];
    return null;
  }

  const api = { SCANCODES, ABNT2_CHARS, ABNT2_DEAD, charToKeys };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TelinhaLib = Object.assign(root.TelinhaLib || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : window);
