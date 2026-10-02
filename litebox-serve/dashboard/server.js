// Alpine dashboard backend, run inside the LiteBox guest.
// Serves the webjsx UI, system info, and two PTY-backed terminals (htop + shell) over SSE/POST.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const PORT = +process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.map':'application/json'};

// ---- terminals -------------------------------------------------------------------------------
const SESSIONS = {};
const MAX_REPLAY = 128 * 1024;

function command(name) {
  return ['/usr/bin/socat', ['-', `EXEC:${path.join(__dirname, name + '.sh')},pty,setsid,ctty,stderr,link=/tmp/pty-${name}`]];
}

function session(name, cols, rows) {
  let s = SESSIONS[name];
  if (s && s.alive) return s;
  s = SESSIONS[name] = {name, alive: true, clients: new Set(), replay: [], replayLen: 0, cols, rows};
  const [bin, args] = command(name);
  s.proc = cp.spawn(bin, args, {env: {PATH: process.env.PATH, TERM: 'xterm-256color', HOME: process.env.HOME || '/home/node', COLS: String(cols), ROWS: String(rows)}});
  s.proc.stdout.on('data', d => emit(s, d));
  s.proc.stderr.on('data', d => emit(s, Buffer.from(d)));
  s.proc.on('error', e => emit(s, Buffer.from('\r\n[failed to start: ' + e.message + ']\r\n')));
  s.proc.on('exit', code => {
    s.alive = false;
    emit(s, Buffer.from(`\r\n\x1b[2m[${name} exited (${code}) - reload or press a key to restart]\x1b[0m\r\n`));
    for (const c of s.clients) c.write('event: exit\ndata: {}\n\n');
  });
  return s;
}
function emit(s, buf) {
  s.replay.push(buf); s.replayLen += buf.length;
  while (s.replayLen > MAX_REPLAY && s.replay.length > 1) s.replayLen -= s.replay.shift().length;
  const msg = 'data: ' + buf.toString('base64') + '\n\n';
  for (const c of s.clients) c.write(msg);
}
function winch(s) {
  try { const pid = +fs.readFileSync(`/tmp/term-${s.name}.pid`, 'utf8'); if (pid) process.kill(pid, 'SIGWINCH'); } catch {}
}
function resize(s, cols, rows) {
  s.cols = cols; s.rows = rows;
  cp.execFile('/bin/stty', ['-F', `/tmp/pty-${s.name}`, 'rows', String(rows), 'cols', String(cols)], () => winch(s));
}

function readBody(req) {
  return new Promise(resolve => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
}
const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, parseInt(v, 10) || d));

// ---- system info -----------------------------------------------------------------------------
function readFile(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } }
function info() {
  let procs = 0; try { procs = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).length; } catch {}
  const mem = {total: os.totalmem(), free: os.freemem()};
  return {
    alpine: readFile('/etc/alpine-release') || 'n/a', hostname: os.hostname(), kernel: os.release(), arch: os.arch(),
    platform: os.platform(), node: process.version, uptime: os.uptime(), cpus: os.cpus().length || 1,
    cpuModel: (readFile('/proc/cpuinfo').match(/model name\s*:\s*(.*)/) || [])[1] || (os.cpus()[0] || {}).model || 'aarch64',
    load: os.loadavg(), mem, procs, nodeUptime: process.uptime(), nodeRss: process.memoryUsage().rss, user: os.userInfo().username,
  };
}

// ---- http ------------------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/info') { res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); return res.end(JSON.stringify(info())); }
    const m = p.match(/^\/api\/term\/(htop|shell)\/(stream|input|resize)$/);
    if (m) {
      const name = m[1], q = url.searchParams;
      const cols = num(q.get('cols'), 80, 10, 500), rows = num(q.get('rows'), 24, 3, 200);
      if (m[2] === 'stream') {
        const s = session(name, cols, rows);
        res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
        res.write(': ok\n\n');
        for (const b of s.replay) res.write('data: ' + b.toString('base64') + '\n\n');
        s.clients.add(res);
        req.on('close', () => s.clients.delete(res));
        if (s.cols !== cols || s.rows !== rows) resize(s, cols, rows); else setTimeout(() => winch(s), 200);
        return;
      }
      if (m[2] === 'input') {
        const body = await readBody(req);
        const s = session(name, cols, rows); // a keypress restarts an exited terminal
        if (s.alive) s.proc.stdin.write(body);
        res.writeHead(204); return res.end();
      }
      const s = session(name, cols, rows);
      if (s.cols !== cols || s.rows !== rows) resize(s, cols, rows);
      res.writeHead(204); return res.end();
    }
    // static
    let rel = p === '/' ? '/index.html' : decodeURIComponent(p);
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, {'Content-Type': 'text/plain'}); return res.end('404 not found'); }
      res.writeHead(200, {'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size});
      fs.createReadStream(file).pipe(res);
    });
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
server.listen(PORT, '0.0.0.0', () => console.log('alpine dashboard on port ' + PORT));

// ---- in-guest self-test (litebox-serve --selftest dashboard) --------------------------------
if (process.env.SELFTEST) {
  const get = (p, onData, ms) => new Promise(resolve => {
    const r = http.get({host: '127.0.0.1', port: PORT, path: p}, res => { res.on('data', onData || (() => {})); res.on('end', resolve); });
    r.on('error', e => { console.log('FAIL', p, e.message); resolve(); });
    if (ms) setTimeout(() => { r.destroy(); resolve(); }, ms);
  });
  const post = (p, body) => new Promise(resolve => { const r = http.request({host: '127.0.0.1', port: PORT, path: p, method: 'POST'}, res => { res.resume(); res.on('end', resolve); }); r.end(body); });
  const decode = chunks => chunks.join('').split('\n').filter(l => l.startsWith('data: ')).map(l => Buffer.from(l.slice(6), 'base64').toString('latin1')).join('');
  server.on('listening', async () => {
    let body = ''; await get('/api/info', d => body += d);
    const i = JSON.parse(body); console.log('INFO alpine=' + i.alpine, 'node=' + i.node, 'arch=' + i.arch, 'procs=' + i.procs);
    let page = ''; await get('/', d => page += d); console.log('INDEX', /alpine/.test(page) ? 'ok' : 'FAIL');
    const sh = [], ht = [];
    const a = get('/api/term/shell/stream?cols=100&rows=30', d => sh.push(d), 6000);
    const b = get('/api/term/htop/stream?cols=100&rows=30', d => ht.push(d), 6000);
    await new Promise(r => setTimeout(r, 1500));
    await post('/api/term/shell/input?cols=100&rows=30', '\x1b[1;1R'); // a real terminal answers ash's cursor-position query (ESC[6n)
    await new Promise(r => setTimeout(r, 300));
    await post('/api/term/shell/input?cols=100&rows=30', 'echo MARK$((6*7))\r');
    await new Promise(r => setTimeout(r, 1500));
    await post('/api/term/shell/resize?cols=120&rows=40', '');
    await post('/api/term/shell/input?cols=120&rows=40', 'stty size\r');
    await Promise.all([a, b]);
    const s = decode(sh), h = decode(ht);
    console.log('SHELL echo', s.includes('MARK42') ? 'ok' : 'FAIL'); console.log('SHELL resize', /40 120/.test(s) ? 'ok' : 'FAIL (' + JSON.stringify(s.slice(-120)) + ')');
    console.log('HTOP bytes=' + h.length, /CPU|Mem|PID/.test(h) ? 'ok' : 'FAIL (' + JSON.stringify(h.slice(0, 200)) + ')');
    process.exit(0);
  });
}
