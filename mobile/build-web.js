// Monta mobile/www a partir da interface do app de PC (src/renderer), com a ponte do Android.
// Uso: node build-web.js   (o "npm run build" já faz isso e sincroniza com o projeto Android)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src', 'renderer');
const www = path.join(__dirname, 'www');
const version = require(path.join(root, 'package.json')).version;

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(path.join(www, 'vendor'), { recursive: true });

// Tudo da interface, menos a camada de ponteiros (só existe no Windows).
const skip = new Set(['overlay.html', 'overlay.js']);
for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
  if (skip.has(entry.name)) continue;
  fs.cpSync(path.join(src, entry.name), path.join(www, entry.name), { recursive: true });
}
fs.copyFileSync(path.join(root, 'node_modules', 'peerjs', 'dist', 'peerjs.min.js'), path.join(www, 'vendor', 'peerjs.min.js'));
fs.writeFileSync(
  path.join(www, 'mobile-shim.js'),
  fs.readFileSync(path.join(__dirname, 'web', 'mobile-shim.js'), 'utf8').replace('__APP_VERSION__', version),
);

let html = fs.readFileSync(path.join(www, 'index.html'), 'utf8');
const swap = (a, b) => {
  if (!html.includes(a)) throw new Error('index.html mudou; não achei: ' + a);
  html = html.replace(a, b);
};
swap('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
swap('<script src="../../node_modules/peerjs/dist/peerjs.min.js"></script>', '<script src="vendor/peerjs.min.js"></script>\n<script src="mobile-shim.js"></script>');
fs.writeFileSync(path.join(www, 'index.html'), html);

console.log(`mobile/www montado (versão ${version}).`);
