// patch-agent.mjs <file>: adapt dsh-dynamic-agent.mjs to the workspace (0.2.0-rc.x) DeepSeekHarness client options (used by ../build-agent.sh).
import fs from 'node:fs'
const file = process.argv[2]
let s = fs.readFileSync(file, 'utf8')
const from = `    launch: {
      command: DSH_BIN,
      args: ['--profile', PROFILE, '--patch', patchPath],
      cwd: process.cwd(),
    },`
const to = `    // Workspace client (0.2.0-rc.x) options. The older rc.1 \`launch\` shape is
    // silently ignored by this client, which would then boot a stock dsh with no
    // patch (and therefore no OpenAI route).
    dshBin: DSH_BIN,
    profile: PROFILE,
    patches: [patchPath],
    dshHome: DSH_HOME,
    processCwd: process.cwd(),
    launch: {
      command: DSH_BIN,
      args: ['--profile', PROFILE, '--patch', patchPath],
      cwd: process.cwd(),
    },`
if (!s.includes(from)) throw new Error('launch block not found: dsh-dynamic-agent.mjs changed upstream')
fs.writeFileSync(file, s.replace(from, to))
