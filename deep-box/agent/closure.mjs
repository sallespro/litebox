// closure.mjs <stageDsh> <harnessDir>  (used by ../build-agent.sh)
// Find bare imports in staged workspace packages that don't resolve inside stageDsh/node_modules, copy the missing
// @deepseek-ai/* workspace packages (package.json + lib) from the harness checkout, repeat until closed.
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
const [stage, harness] = process.argv.slice(2)
const nm = path.join(stage, 'node_modules')
const builtins = new Set(builtinModules.flatMap(m => [m, m.replace(/^node:/, '')]))
// workspace package name -> dir
const ws = new Map()
for (const group of fs.readdirSync(path.join(harness, 'packages'))) {
  const g = path.join(harness, 'packages', group)
  if (!fs.statSync(g).isDirectory()) continue
  for (const p of fs.readdirSync(g)) {
    const pj = path.join(g, p, 'package.json')
    if (fs.existsSync(pj)) ws.set(JSON.parse(fs.readFileSync(pj, 'utf8')).name, path.join(g, p))
  }
}
for (const p of fs.readdirSync(path.join(harness, 'apps'))) {
  const pj = path.join(harness, 'apps', p, 'package.json')
  if (fs.existsSync(pj)) ws.set(JSON.parse(fs.readFileSync(pj, 'utf8')).name, path.join(harness, 'apps', p))
}
const spec = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"'./][^"']*)["']/g
function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') yield* walk(f) } else if (/\.(m?js|cjs)$/.test(e.name)) yield f
  }
}
const pkgName = s => s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]
function scanRoots() { return [path.join(stage, 'lib'), ...fs.readdirSync(path.join(nm, '@deepseek-ai')).map(n => path.join(nm, '@deepseek-ai', n))] }
let round = 0
for (;;) {
  const missing = new Map()
  for (const root of scanRoots()) {
    if (!fs.existsSync(root)) continue
    for (const f of walk(root)) {
      const src = fs.readFileSync(f, 'utf8')
      for (const m of src.matchAll(spec)) {
        const name = pkgName(m[1])
        if (builtins.has(name) || builtins.has(m[1]) || !/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name) || /(^|\/)client[^/]*\.js$/.test(f)) continue
        if (!fs.existsSync(path.join(nm, name)) && !fs.existsSync(path.join(root, 'node_modules', name))) {
          if (!missing.has(name)) missing.set(name, f.replace(stage, ''))
        }
      }
    }
  }
  const ours = [...missing].filter(([n]) => ws.has(n)), other = [...missing].filter(([n]) => !ws.has(n))
  if (ours.length === 0) { console.log('closed after', round, 'rounds; third-party still missing:', other.map(([n, f]) => `${n} (from ${f})`)); break }
  for (const [name] of ours) {
    const src = ws.get(name), dst = path.join(nm, name)
    fs.mkdirSync(dst, { recursive: true })
    fs.copyFileSync(path.join(src, 'package.json'), path.join(dst, 'package.json'))
    if (fs.existsSync(path.join(src, 'lib'))) fs.cpSync(path.join(src, 'lib'), path.join(dst, 'lib'), { recursive: true, filter: s => !/\.(d\.ts|map)$/.test(s) })
    console.log('added', name)
  }
  round++
}
