// Static file server run inside the LiteBox guest. The served dir is mounted at /www.
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = '/www', PORT = +process.env.PORT || 8080;
const TYPES = {'.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.pdf':'application/pdf','.wasm':'application/wasm','.woff2':'font/woff2','.mp4':'video/mp4','.xml':'application/xml'};
const esc = s => s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end('bad request'); }
  const file = path.join(ROOT, path.normalize(rel));
  if (file !== ROOT && !file.startsWith(ROOT + '/')) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/plain'}); return res.end('404 not found'); }
    if (st.isDirectory()) {
      const index = path.join(file, 'index.html');
      if (fs.existsSync(index)) return send(index, res);
      if (!rel.endsWith('/')) { res.writeHead(301, {Location: rel + '/'}); return res.end(); }
      const items = fs.readdirSync(file, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
        .map(d => `<li><a href="${encodeURIComponent(d.name)}${d.isDirectory() ? '/' : ''}">${esc(d.name)}${d.isDirectory() ? '/' : ''}</a></li>`);
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      return res.end(`<!doctype html><meta charset=utf-8><title>Index of ${esc(rel)}</title><h1>Index of ${esc(rel)}</h1><ul>${rel !== '/' ? '<li><a href="../">../</a></li>' : ''}${items.join('')}</ul>`);
    }
    send(file, res);
  });
  console.log(req.method, req.url);
});
function send(file, res) {
  res.writeHead(200, {'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'});
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}
server.listen(PORT, '0.0.0.0', () => {
  console.log('serving ' + ROOT + ' on port ' + PORT);
  if (process.env.SELFTEST) {
    http.get({host: '127.0.0.1', port: PORT, path: process.env.SELFTEST}, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { console.log('SELFTEST status=' + r.statusCode + ' bytes=' + d.length + '\n' + d.slice(0, 300)); process.exit(0); });
    });
  }
});
