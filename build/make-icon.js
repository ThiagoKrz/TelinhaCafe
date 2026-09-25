// Gera o ícone do Telinha Café a partir do logo do Fate Café.
// Uso: npx electron build/make-icon.js
// Saída: build/icon.png (256), build/icon.ico (256/128/64/48/32/16) e src/renderer/icon.png
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const logo = fs.readFileSync(path.join(root, 'src', 'renderer', 'fate-cafe-logo.webp')).toString('base64');

// Desenha no canvas do Chromium e devolve PNGs (base64) em vários tamanhos.
const drawScript = `
(async () => {
  const img = new Image();
  img.src = 'data:image/webp;base64,${logo}';
  await img.decode();

  function draw(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const s = size / 256;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';

    const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x * s, y * s, w * s, h * s, r * s); };

    // Fundo café com leve degradê e borda caramelo
    rr(8, 8, 240, 240, 56);
    const bg = g.createLinearGradient(0, 0, 0, size);
    bg.addColorStop(0, '#3E322F');
    bg.addColorStop(1, '#1C1614');
    g.fillStyle = bg;
    g.fill();
    g.lineWidth = 6 * s;
    g.strokeStyle = '#D4A373';
    g.stroke();

    // Selo do Fate Café
    const d = 184;
    g.save();
    g.shadowColor = 'rgba(0,0,0,.45)';
    g.shadowBlur = 10 * s;
    g.drawImage(img, (122 - d / 2) * s, (116 - d / 2) * s, d * s, d * s);
    g.restore();

    // Selinho da "telinha" no canto
    const cx = 208, cy = 208, r = 36;
    g.beginPath();
    g.arc(cx * s, cy * s, (r + 5) * s, 0, Math.PI * 2);
    g.fillStyle = '#1C1614';
    g.fill();
    g.beginPath();
    g.arc(cx * s, cy * s, r * s, 0, Math.PI * 2);
    g.fillStyle = '#D4A373';
    g.fill();
    // monitor
    g.fillStyle = '#241D1A';
    rr(cx - 21, cy - 16, 42, 27, 5); g.fill();
    g.fillStyle = '#F1D6AE';
    rr(cx - 17, cy - 12, 34, 19, 3); g.fill();
    g.fillStyle = '#241D1A';
    g.fillRect((cx - 3) * s, (cy + 11) * s, 6 * s, 6 * s);
    rr(cx - 12, cy + 16, 24, 5, 2.5); g.fill();
    // play
    g.beginPath();
    g.moveTo((cx - 4) * s, (cy - 8) * s);
    g.lineTo((cx - 4) * s, (cy + 4) * s);
    g.lineTo((cx + 7) * s, (cy - 2) * s);
    g.closePath();
    g.fillStyle = '#A2564C';
    g.fill();

    return c.toDataURL('image/png').split(',')[1];
  }

  const out = {};
  for (const size of [256, 128, 64, 48, 32, 16]) out[size] = draw(size);
  return out;
})()
`;

function buildIco(pngs) {
  const sizes = Object.keys(pngs).map(Number).sort((a, b) => b - a);
  const bufs = sizes.map((sz) => Buffer.from(pngs[sz], 'base64'));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((sz, i) => {
    const e = i * 16;
    dir.writeUInt8(sz >= 256 ? 0 : sz, e);
    dir.writeUInt8(sz >= 256 ? 0 : sz, e + 1);
    dir.writeUInt8(0, e + 2);
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(bufs[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += bufs[i].length;
  });
  return Buffer.concat([header, dir, ...bufs]);
}

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false });
  await w.loadURL('about:blank');
  const pngs = await w.webContents.executeJavaScript(drawScript);
  const png256 = Buffer.from(pngs[256], 'base64');
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), png256);
  fs.writeFileSync(path.join(root, 'src', 'renderer', 'icon.png'), png256);
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), buildIco(pngs));
  console.log('Ícones gerados.');
  app.quit();
});
