'use strict';

/* Desenha ponteiros, marcações (clique) e riscos dos amigos sobre uma tela compartilhada.
   Coordenadas sempre normalizadas (0..1) em relação à imagem compartilhada.
   Usado nos vídeos dentro do app e na camada transparente por cima do monitor de quem compartilha. */
(function () {
  const POINTER_TTL = 3000;
  const LAST_POS_TTL = 120000;
  const STROKE_HOLD = 3500;
  const STROKE_FADE = 1200;
  const MARK_TTL = 900;
  const CHAT_FADE = 800;
  const CHAT_MAX_MSGS = 3;

  const ok = (v) => typeof v === 'number' && v >= -0.05 && v <= 1.05;

  function wrapLines(g, text, maxW, maxLines) {
    const out = [];
    const pushLine = (line) => {
      if (out.length < maxLines) out.push(line);
      else if (out.length === maxLines) {
        let last = out[maxLines - 1];
        while (last.length > 1 && g.measureText(last + '…').width > maxW) last = last.slice(0, -1);
        out[maxLines - 1] = last + '…';
      }
    };
    for (const para of text.split(/\r?\n/)) {
      let cur = '';
      for (const word of para.split(/\s+/)) {
        if (!word) continue;
        const candidate = cur ? cur + ' ' + word : word;
        if (g.measureText(candidate).width <= maxW) {
          cur = candidate;
        } else {
          if (cur) { pushLine(cur); cur = ''; if (out.length >= maxLines) return out; }
          if (g.measureText(word).width <= maxW) {
            cur = word;
          } else {
            let chunk = '';
            for (const ch of word) {
              if (g.measureText(chunk + ch).width > maxW && chunk) {
                pushLine(chunk);
                chunk = ch;
                if (out.length >= maxLines) return out;
              } else chunk += ch;
            }
            cur = chunk;
          }
        }
      }
      if (cur) { pushLine(cur); if (out.length >= maxLines) return out; }
    }
    return out;
  }

  class AnnotLayer {
    constructor(canvas, getRect) {
      this.c = canvas;
      this.g = canvas.getContext('2d');
      this.getRect = getRect || (() => ({ x: 0, y: 0, w: canvas.clientWidth, h: canvas.clientHeight }));
      this.pointers = new Map();
      this.lastPos = new Map();
      this.chats = new Map();
      this.strokes = new Map();
      this.marks = [];
      this.raf = 0;
    }

    // evt: { type: 'ptr'|'ctrl-ptr'|'stroke'|'mark'|'chat', from, name, color, x, y, sid, pts, end, text, ctrl }
    handle(evt) {
      const now = performance.now();
      const color = /^#[0-9a-f]{6}$/i.test(evt.color) ? evt.color : '#5b8cff';
      const name = String(evt.name || '').slice(0, 24);
      if (evt.type === 'ptr') {
        if (evt.x == null) this.pointers.delete(evt.from);
        else if (ok(evt.x) && ok(evt.y)) {
          const entry = { x: evt.x, y: evt.y, name, color, t: now, ctrl: false };
          this.pointers.set(evt.from, entry);
          this.lastPos.set(evt.from, entry);
        }
      } else if (evt.type === 'ctrl-ptr') {
        if (evt.x == null) {
          const prev = this.lastPos.get(evt.from);
          if (prev && prev.ctrl) this.lastPos.delete(evt.from);
          if (!this.chats.has(evt.from)) return;
        } else if (ok(evt.x) && ok(evt.y)) {
          const prev = this.lastPos.get(evt.from);
          this.lastPos.set(evt.from, { x: evt.x, y: evt.y, name, color: (prev && prev.color) || color, t: now, ctrl: true });
          if (!this.chats.has(evt.from)) return;
        } else return;
      } else if (evt.type === 'stroke') {
        const key = `${evt.from}:${evt.sid}`;
        let s = this.strokes.get(key);
        if (!s) {
          if (this.strokes.size > 60) return;
          const w = [1, 2, 3].includes(evt.w) ? evt.w : 1;
          s = { pts: [], color, w, t: now, done: false };
          this.strokes.set(key, s);
        }
        for (const p of Array.isArray(evt.pts) ? evt.pts.slice(0, 300) : []) {
          if (Array.isArray(p) && ok(p[0]) && ok(p[1]) && s.pts.length < 3000) s.pts.push([p[0], p[1]]);
        }
        if (s.pts.length) {
          const last = s.pts[s.pts.length - 1];
          const prev = this.lastPos.get(evt.from);
          this.lastPos.set(evt.from, { x: last[0], y: last[1], name: name || (prev && prev.name) || '', color: (prev && prev.color) || color, t: now, ctrl: false });
        }
        s.t = now;
        if (evt.end) s.done = true;
      } else if (evt.type === 'mark') {
        if (ok(evt.x) && ok(evt.y) && this.marks.length < 30) {
          this.marks.push({ x: evt.x, y: evt.y, color, t0: now });
          const prev = this.lastPos.get(evt.from);
          this.lastPos.set(evt.from, { x: evt.x, y: evt.y, name: name || (prev && prev.name) || '', color: (prev && prev.color) || color, t: now, ctrl: false });
        }
      } else if (evt.type === 'chat') {
        const text = String(evt.text || '').trim().slice(0, 220);
        if (!text) return;
        const active = this.pointers.get(evt.from);
        let pos = active || this.lastPos.get(evt.from);
        if (pos && !active && now - pos.t > LAST_POS_TTL) pos = null;
        if (!pos && ok(evt.x) && ok(evt.y)) {
          pos = { x: evt.x, y: evt.y, name, color, t: now, ctrl: !!evt.ctrl };
          this.lastPos.set(evt.from, pos);
        }
        if (!pos) return;
        pos.t = now;
        const ttl = Math.min(10000, Math.max(4500, 3500 + text.length * 55));
        const cur = this.chats.get(evt.from) || { name: name || pos.name, color: pos.color || color, msgs: [] };
        cur.name = name || cur.name || pos.name;
        cur.color = pos.color || color;
        cur.msgs = cur.msgs.filter((m) => now - m.t0 < m.ttl);
        cur.msgs.push({ text, t0: now, ttl });
        if (cur.msgs.length > CHAT_MAX_MSGS) cur.msgs.shift();
        this.chats.set(evt.from, cur);
      }
      this.kick();
    }

    clear() {
      this.pointers.clear();
      this.lastPos.clear();
      this.chats.clear();
      this.strokes.clear();
      this.marks = [];
      this.kick();
    }

    kick() {
      if (!this.raf) this.raf = requestAnimationFrame(() => this.draw());
    }

    draw() {
      this.raf = 0;
      const c = this.c;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth;
      const H = c.clientHeight;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      const g = this.g;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const r = this.getRect();
      const X = (x) => r.x + x * r.w;
      const Y = (y) => r.y + y * r.h;
      const now = performance.now();
      let alive = false;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.shadowColor = 'rgba(0,0,0,.6)';
      g.shadowBlur = 4;

      for (const [key, s] of this.strokes) {
        if (!s.done && now - s.t > 8000) s.done = true;
        const age = s.done ? now - s.t : 0;
        if (age > STROKE_HOLD + STROKE_FADE) {
          this.strokes.delete(key);
          continue;
        }
        alive = true;
        if (s.pts.length < 2) continue;
        g.globalAlpha = age < STROKE_HOLD ? 1 : 1 - (age - STROKE_HOLD) / STROKE_FADE;
        g.strokeStyle = s.color;
        g.lineWidth = Math.max(3, r.w / 380) * (s.w === 3 ? 2.6 : s.w === 2 ? 1.7 : 1);
        g.beginPath();
        s.pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
        g.stroke();
      }

      this.marks = this.marks.filter((m) => {
        const t = (now - m.t0) / MARK_TTL;
        if (t >= 1) return false;
        alive = true;
        g.globalAlpha = 1 - t;
        g.strokeStyle = m.color;
        g.lineWidth = 4;
        g.beginPath();
        g.arc(X(m.x), Y(m.y), 10 + t * 45, 0, Math.PI * 2);
        g.stroke();
        return true;
      });

      g.font = '600 12px "Segoe UI", sans-serif';
      for (const [id, p] of this.pointers) {
        const age = now - p.t;
        if (age > POINTER_TTL) {
          this.pointers.delete(id);
          continue;
        }
        alive = true;
        g.globalAlpha = age < POINTER_TTL - 600 ? 1 : (POINTER_TTL - age) / 600;
        const px = X(p.x);
        const py = Y(p.y);
        g.fillStyle = p.color;
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(px, py, 7, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        if (p.name) {
          g.shadowBlur = 0;
          const tw = g.measureText(p.name).width;
          g.fillStyle = 'rgba(0,0,0,.72)';
          g.beginPath();
          g.roundRect(px + 10, py + 8, tw + 12, 20, 6);
          g.fill();
          g.fillStyle = '#fff';
          g.fillText(p.name, px + 16, py + 22);
          g.shadowBlur = 4;
        }
      }

      for (const [id, chat] of this.chats) {
        chat.msgs = chat.msgs.filter((m) => now - m.t0 < m.ttl);
        if (!chat.msgs.length) {
          this.chats.delete(id);
          continue;
        }
        const ptr = this.pointers.get(id);
        const pos = ptr || this.lastPos.get(id);
        if (!pos) {
          this.chats.delete(id);
          continue;
        }
        alive = true;
        const px = X(pos.x);
        const py = Y(pos.y);

        // Calcula opacidade suave (pop-in na entrada, fade-out no final).
        const latest = chat.msgs[chat.msgs.length - 1];
        const rem = Math.max(...chat.msgs.map((m) => m.ttl - (now - m.t0)));
        const fadeOut = rem < CHAT_FADE ? Math.max(0, rem / CHAT_FADE) : 1;
        const fadeIn = Math.min(1, (now - latest.t0) / 140);
        const alpha = fadeIn * fadeOut;

        // Se a pessoa tirou o mouse do vídeo pra digitar no chat (modo desenho), ancora o ponteiro no último lugar.
        if (!ptr && !pos.ctrl) {
          g.globalAlpha = alpha * 0.9;
          g.fillStyle = chat.color;
          g.strokeStyle = '#fff';
          g.lineWidth = 2;
          g.shadowBlur = 4;
          g.beginPath();
          g.arc(px, py, 6, 0, Math.PI * 2);
          g.fill();
          g.stroke();
        }

        const padX = 11;
        const padY = 8;
        const lineH = 17;
        const gapMsg = 6;
        const maxTextW = Math.min(280, Math.max(150, W - 40));

        g.font = '600 11px "Segoe UI", sans-serif';
        const showHeader = !!chat.name;
        const headerH = showHeader ? 16 : 0;
        let maxLineW = showHeader ? g.measureText(chat.name).width : 0;

        g.font = '400 13px "Segoe UI", sans-serif';
        const blocks = chat.msgs.map((m) => {
          const lines = wrapLines(g, m.text, maxTextW, 4);
          for (const ln of lines) maxLineW = Math.max(maxLineW, g.measureText(ln).width);
          return lines;
        });

        const bw = Math.ceil(maxLineW) + padX * 2;
        const totalLines = blocks.reduce((acc, b) => acc + b.length, 0);
        const bh = padY * 2 + headerH + totalLines * lineH + Math.max(0, blocks.length - 1) * gapMsg;

        // Posiciona acima e à direita do mouse; se bater na borda, vira pro lado livre.
        let bx = px + 14;
        let by = py - bh - 12;
        if (by < 10) by = py + (ptr ? 34 : 18);
        if (bx + bw > W - 10) bx = px - bw - 14;
        bx = Math.max(8, Math.min(Math.max(8, W - bw - 8), bx));
        by = Math.max(8, Math.min(Math.max(8, H - bh - 8), by));

        g.globalAlpha = alpha;
        g.shadowColor = 'rgba(0,0,0,.55)';
        g.shadowBlur = 12;
        g.fillStyle = 'rgba(36, 29, 26, 0.94)';
        g.strokeStyle = chat.color;
        g.lineWidth = 2;
        g.beginPath();
        g.roundRect(bx, by, bw, bh, 11);
        g.fill();
        g.shadowBlur = 0;
        g.stroke();

        let cy = by + padY;
        if (showHeader) {
          g.font = '700 11px "Segoe UI", sans-serif';
          g.fillStyle = chat.color;
          g.fillText(chat.name, bx + padX, cy + 10);
          cy += headerH;
        }
        g.font = '400 13px "Segoe UI", sans-serif';
        blocks.forEach((lines, bi) => {
          if (bi > 0) {
            g.strokeStyle = 'rgba(234, 224, 213, 0.14)';
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(bx + padX, cy - gapMsg / 2);
            g.lineTo(bx + bw - padX, cy - gapMsg / 2);
            g.stroke();
          }
          g.fillStyle = '#F1DFC8';
          for (const ln of lines) {
            g.fillText(ln, bx + padX, cy + 13);
            cy += lineH;
          }
          cy += gapMsg;
        });
        g.shadowBlur = 4;
      }

      g.globalAlpha = 1;
      if (alive) this.kick();
    }
  }

  window.AnnotLayer = AnnotLayer;
})();
