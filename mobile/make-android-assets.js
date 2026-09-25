// Gera ícones (normal, redondo e adaptável) e telas de abertura do Android a partir do logo do Fate Café.
// Uso: npx electron make-android-assets.js   (rodar dentro de mobile/, depois do "npx cap add android")
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const res = path.join(__dirname, 'android', 'app', 'src', 'main', 'res');
const b64 = (f) => fs.readFileSync(f).toString('base64');
const logo = b64(path.join(root, 'src', 'renderer', 'fate-cafe-logo.webp'));
const font = b64(path.join(root, 'src', 'renderer', 'fonts', 'exo-2-latin-700-normal.woff2'));

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

// Lista de tudo que vai ser desenhado: { file, w, h, kind }
const jobs = [];
for (const [d, k] of Object.entries(DENSITIES)) {
  const dir = path.join(res, `mipmap-${d}`);
  jobs.push({ file: path.join(dir, 'ic_launcher.png'), w: 48 * k, h: 48 * k, kind: 'square' });
  jobs.push({ file: path.join(dir, 'ic_launcher_round.png'), w: 48 * k, h: 48 * k, kind: 'round' });
  jobs.push({ file: path.join(dir, 'ic_launcher_foreground.png'), w: 108 * k, h: 108 * k, kind: 'foreground' });
}
// Telas de abertura: substitui cada splash.png que o Capacitor criou, mantendo o tamanho.
function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
for (const dir of fs.readdirSync(res)) {
  const f = path.join(res, dir, 'splash.png');
  if (dir.startsWith('drawable') && fs.existsSync(f)) jobs.push({ file: f, ...pngSize(f), kind: 'splash' });
}

const script = `
(async () => {
  const img = new Image();
  img.src = 'data:image/webp;base64,${logo}';
  await img.decode();
  const face = new FontFace('Exo 2', 'url(data:font/woff2;base64,${font})', { weight: '700' });
  document.fonts.add(await face.load());
  const jobs = ${JSON.stringify(jobs.map((j) => ({ w: Math.round(j.w), h: Math.round(j.h), kind: j.kind })))};

  function monitorChip(g, cx, cy, r) {
    g.beginPath(); g.arc(cx, cy, r * 1.14, 0, Math.PI * 2); g.fillStyle = '#1C1614'; g.fill();
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = '#D4A373'; g.fill();
    const u = r / 36;
    g.fillStyle = '#241D1A'; g.beginPath(); g.roundRect(cx - 21 * u, cy - 16 * u, 42 * u, 27 * u, 5 * u); g.fill();
    g.fillStyle = '#F1D6AE'; g.beginPath(); g.roundRect(cx - 17 * u, cy - 12 * u, 34 * u, 19 * u, 3 * u); g.fill();
    g.fillStyle = '#241D1A'; g.fillRect(cx - 3 * u, cy + 11 * u, 6 * u, 6 * u);
    g.beginPath(); g.roundRect(cx - 12 * u, cy + 16 * u, 24 * u, 5 * u, 2.5 * u); g.fill();
    g.beginPath(); g.moveTo(cx - 4 * u, cy - 8 * u); g.lineTo(cx - 4 * u, cy + 4 * u); g.lineTo(cx + 7 * u, cy - 2 * u); g.closePath();
    g.fillStyle = '#A2564C'; g.fill();
  }

  function draw({ w, h, kind }) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    const s = Math.min(w, h);
    if (kind === 'square' || kind === 'round') {
      g.beginPath();
      if (kind === 'round') g.arc(w / 2, h / 2, s / 2, 0, Math.PI * 2);
      else g.roundRect(0, 0, w, h, s * 0.2);
      g.fillStyle = '#2A2320'; g.fill();
      const d = s * 0.74;
      g.drawImage(img, (w - d) / 2 - s * 0.03, (h - d) / 2 - s * 0.04, d, d);
      monitorChip(g, w * 0.8, h * 0.8, s * 0.115);
    } else if (kind === 'foreground') {
      // Área segura do ícone adaptável: 72 de 108 (2/3) no centro.
      const d = s * 0.6;
      g.drawImage(img, (w - d) / 2, (h - d) / 2, d, d);
      monitorChip(g, w * 0.68, h * 0.68, s * 0.085);
    } else {
      g.fillStyle = '#2A2320'; g.fillRect(0, 0, w, h);
      const glow = g.createRadialGradient(w / 2, h * 0.3, 0, w / 2, h * 0.3, s * 0.9);
      glow.addColorStop(0, 'rgba(212,163,115,.18)'); glow.addColorStop(1, 'rgba(212,163,115,0)');
      g.fillStyle = glow; g.fillRect(0, 0, w, h);
      const d = s * 0.32;
      g.drawImage(img, (w - d) / 2, h / 2 - d * 0.7, d, d);
      const fs = Math.max(12, s * 0.07);
      g.font = '700 ' + fs + 'px "Exo 2"';
      g.textAlign = 'center'; g.textBaseline = 'top';
      const y = h / 2 + d * 0.42;
      const a = 'Telinha ', b = 'Café';
      const wa = g.measureText(a).width, wb = g.measureText(b).width;
      const x0 = w / 2 - (wa + wb) / 2;
      g.textAlign = 'left';
      g.fillStyle = '#EAE0D5'; g.fillText(a, x0, y);
      g.fillStyle = '#D4A373'; g.fillText(b, x0 + wa, y);
    }
    return c.toDataURL('image/png').split(',')[1];
  }
  return jobs.map(draw);
})()
`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false });
  await w.loadURL('about:blank');
  const out = await w.webContents.executeJavaScript(script);
  out.forEach((png, i) => fs.writeFileSync(jobs[i].file, Buffer.from(png, 'base64')));
  // Fundo do ícone adaptável na cor café.
  const bgXml = path.join(res, 'values', 'ic_launcher_background.xml');
  fs.writeFileSync(bgXml, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#2A2320</color>\n</resources>\n');
  console.log(`${out.length} imagens do Android geradas.`);
  app.quit();
});
