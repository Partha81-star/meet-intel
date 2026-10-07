// Keep dependencies/build output on the system drive; support slow external workspaces.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'renderer');
const savedRuntime = path.join(root, '.runtime', 'runtime.txt');
const runtime = process.env.MEETINTEL_RUNTIME || (fs.existsSync(savedRuntime) ? fs.readFileSync(savedRuntime, 'utf8').trim() : path.join(process.env.LOCALAPPDATA || os.homedir(), 'MeetIntel', 'runtime'));
const target = path.join(runtime, 'renderer');
fs.mkdirSync(target, { recursive: true });
function sync() {
  for (const name of ['src', 'public', 'package.json', 'package-lock.json', 'next.config.js', 'tailwind.config.js', 'postcss.config.js', '.env.local']) {
    const file = path.join(source, name);
    if (fs.existsSync(file)) fs.cpSync(file, path.join(target, name), { recursive: true });
  }
}
sync();
const command = process.argv[2] || 'dev';
const desktop = command === 'desktop';
const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', desktop ? 'build' : command], {
  cwd: target, stdio: 'inherit', shell: process.platform === 'win32',
  env: { ...process.env, ...(desktop ? { DESKTOP_BUILD: '1', NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000', NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL || 'ws://127.0.0.1:8000/ws/transcribe' } : {}) },
});
let watcher;
let timer;
if (command === 'dev') watcher = fs.watch(path.join(source, 'src'), { recursive: true }, () => {
  clearTimeout(timer); timer = setTimeout(sync, 150);
});
child.on('exit', code => {
  watcher?.close(); clearTimeout(timer);
  if (desktop && code === 0) fs.cpSync(path.join(target, 'out'), path.join(source, 'out'), { recursive: true });
  process.exit(code ?? 1);
});
child.on('error', error => { console.error(error.message); process.exit(1); });
