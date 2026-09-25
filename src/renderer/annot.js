'use strict';

/* Desenha ponteiros, marcações (clique) e riscos dos amigos sobre uma tela compartilhada.
   Coordenadas sempre normalizadas (0..1) em relação à imagem compartilhada.
   Usado nos vídeos dentro do app e na camada transparente por cima do monitor de quem compartilha. */
(function () {
  const POINTER_TTL = 3000;
  const STROKE_HOLD = 3500;
  const STROKE_FADE = 1200;
  const MARK_TTL = 900;

  const ok = (v) => typeof v === 'number' && v >= -0.05 && v <= 1.05;

  class AnnotLayer {
    constructor(canvas, getRect) {
      this.c = canvas;
      this.g = canvas.getContext('2d');
      this.getRect = getRect || (() => ({ x: 0, y: 0, w: canvas.clientWidth, h: canvas.clientHeight }));
      this.pointers = new Map();
      this.strokes = new Map();
      this.marks = [];
      this.raf = 0;
    }

    // evt: { type: 'ptr'|'stroke'|'mark', from, name, color, x, y, sid, pts, end }
    handle(evt) {
      const now = performance.now();
      const color = /^#[0-9a-f]{6}$/i.test(evt.color) ? evt.color : '#5b8cff';
      const name = String(evt.name || '').slice(0, 24);
      if (evt.type === 'ptr') {
        if (evt.x == null) this.pointers.delete(evt.from);
        else if (ok(evt.x) && ok(evt.y)) this.pointers.set(evt.from, { x: evt.x, y: evt.y, name, color, t: now });
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
        s.t = now;
        if (evt.end) s.done = true;
      } else if (evt.type === 'mark') {
        if (ok(evt.x) && ok(evt.y) && this.marks.length < 30) this.marks.push({ x: evt.x, y: evt.y, color, t0: now });
      }
      this.kick();
    }

    clear() {
      this.pointers.clear();
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
      g.globalAlpha = 1;
      if (alive) this.kick();
    }
  }

  window.AnnotLayer = AnnotLayer;
})();
