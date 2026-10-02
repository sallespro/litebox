// Alpine-on-LiteBox dashboard: webjsx + the 247420 design system, two xterm.js terminals.
import { webjsx, components as C } from '/vendor/247420.js';
const h = webjsx.createElement;

const fmtBytes = n => n >= 2 ** 30 ? (n / 2 ** 30).toFixed(1) + ' GiB' : (n / 2 ** 20).toFixed(0) + ' MiB';
const fmtUp = s => { s = Math.floor(s); const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + (hh ? hh + 'h ' : '') + m + 'm ' + (s % 60) + 's'; };

// ---- layout (rendered once; terminals own their DOM, kpis/status are re-diffed) --------------
const root = document.getElementById('app');
webjsx.applyDiff(root, [
  C.Topbar({ brand: 'alpine', leaf: 'litebox', items: [], active: '' }),
  h('main', { class: 'dash' },
    h('div', { id: 'kpis' }),
    h('div', { class: 'terms' },
      h('div', { class: 'term-panel' }, C.Panel({ title: 'htop', right: h('span', { id: 'htop-state' }, 'connecting'), children: h('div', { id: 'term-htop', class: 'term-host' }) })),
      h('div', { class: 'term-panel' }, C.Panel({ title: 'shell', right: h('span', { id: 'shell-state' }, 'connecting'), children: h('div', { id: 'term-shell', class: 'term-host' }) })))),
  h('div', { id: 'status' }),
]);

// ---- live system info ------------------------------------------------------------------------
async function refresh() {
  try {
    const i = await (await fetch('/api/info', { cache: 'no-store' })).json();
    const used = i.mem.total - i.mem.free;
    webjsx.applyDiff(document.getElementById('kpis'), C.Kpi({ items: [
      [i.alpine, 'alpine'],
      [fmtUp(i.uptime), 'uptime'],
      [fmtBytes(used) + ' / ' + fmtBytes(i.mem.total), 'memory'],
      [String(i.procs), 'processes'],
      [i.node, 'node'],
      [i.arch + ' · ' + i.cpus + ' cpu', 'cpu'],
    ] }));
    webjsx.applyDiff(document.getElementById('status'), C.Status({
      left: [i.hostname + ' · ' + i.user + '@' + i.platform + ' ' + i.kernel],
      right: [C.Chip({ tone: 'live', children: 'litebox · hvf' })],
    }));
  } catch (e) {
    webjsx.applyDiff(document.getElementById('status'), C.Status({ left: ['disconnected: ' + e.message], right: [C.Chip({ tone: 'idle', children: 'offline' })] }));
  }
}
refresh(); setInterval(refresh, 2000);

// ---- terminals -------------------------------------------------------------------------------
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

function attach(name) {
  const el = document.getElementById('term-' + name), state = document.getElementById(name + '-state');
  const term = new Terminal({ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, cursorBlink: true, scrollback: 2000, theme: { background: '#0b0b0c' } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit); term.open(el); fit.fit();
  const q = () => `cols=${term.cols}&rows=${term.rows}`;
  const setState = t => { state.textContent = t; };

  let es;
  function connect() {
    es = new EventSource(`/api/term/${name}/stream?${q()}`);
    es.onopen = () => { term.reset(); setState('live'); };
    es.onmessage = e => term.write(b64(e.data));
    es.addEventListener('exit', () => setState('exited'));
    es.onerror = () => setState('reconnecting');
  }
  connect();

  // keystrokes are POSTed in order
  let chain = Promise.resolve();
  term.onData(d => { chain = chain.then(() => fetch(`/api/term/${name}/input?${q()}`, { method: 'POST', body: d }).catch(() => {})); });

  let t;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => fit.fit(), 80); }).observe(el);
  term.onResize(() => fetch(`/api/term/${name}/resize?${q()}`, { method: 'POST' }).catch(() => {}));
  return term;
}
const terms = { htop: attach('htop'), shell: attach('shell') };
terms.shell.focus();
