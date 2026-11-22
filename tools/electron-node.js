// Runs a script with Electron's bundled Node (which includes node:sqlite) on any OS.
// Usage: node tools/electron-node.js <script> [args...]
const { spawnSync } = require('child_process');
const electron = require('electron'); // path to the Electron binary when required from Node
const r = spawnSync(electron, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
process.exit(r.status === null ? 1 : r.status);
