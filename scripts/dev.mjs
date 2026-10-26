import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { watchFile, unwatchFile } from 'node:fs';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const children = new Set();
let stopping = false;
let restartingBackend = false;
let backend;
const envPath = path.join(root, 'backend/.env');
function startBackend() {
  backend = spawn(process.execPath, ['--watch', 'server.js'], { cwd: path.join(root, 'backend'), stdio: 'inherit' });
  children.add(backend);
  backend.on('error', error => { console.error(error.message); stop(1); });
  backend.on('exit', code => {
    children.delete(backend);
    if (stopping) return;
    if (restartingBackend) { restartingBackend = false; startBackend(); }
    else stop(code || 0);
  });
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  unwatchFile(envPath);
  children.forEach(child => child.kill('SIGTERM'));
  setTimeout(() => process.exit(code), 300).unref();
}
startBackend();
const frontend = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd: path.join(root, 'frontend'), stdio: 'inherit' });
children.add(frontend);
frontend.on('exit', code => stop(code || 0));
frontend.on('error', error => { console.error(error.message); stop(1); });
watchFile(envPath, { interval: 1000 }, (current, previous) => {
  if (stopping || restartingBackend || current.mtimeMs === previous.mtimeMs) return;
  restartingBackend = true;
  console.log('Supabase configuration changed; restarting the backend…');
  backend.kill('SIGTERM');
});
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
