// Publish the built app and API through one temporary HTTPS development link.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = process.env.PHONE_PORT || process.env.PORT || '4000';
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error('PHONE_PORT must be a valid local port.');
  process.exit(1);
}
const origin = `http://127.0.0.1:${port}`;
const probe = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.error('Install the HTTPS tunnel first: brew install cloudflared');
  process.exit(1);
}
if (!existsSync(path.join(root, 'frontend/dist/index.html'))) {
  console.error('Build the app first: npm run build');
  process.exit(1);
}
try {
  const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(5000) });
  const health = await response.json();
  if (!response.ok || !health.ok || health.model?.state !== 'ready' || !health.configured || !health.writeEnabled) {
    throw new Error('The app, database connection, or model is not ready. Check Connection setup.');
  }
  const home = await fetch(origin, { signal: AbortSignal.timeout(5000) });
  if (!home.ok || !(await home.text()).includes('id="root"')) {
    throw new Error('The backend is not serving the built app. Restart it after npm run build.');
  }
} catch (error) {
  console.error(`Cannot share ParkVision at ${origin}: ${error.message}\nStart the app with npm run dev (or npm start) in another terminal.`);
  process.exit(1);
}
console.log('Starting a temporary HTTPS link for the built ParkVision app and API.');
console.log('Open the trycloudflare.com link printed below on your phone.');
console.log('Sign in with your ParkVision personnel account, then choose Use device camera.');
console.log('Keep the laptop awake, backend running, and this terminal open. Ctrl+C closes the link.');
const tunnel = spawn('cloudflared', ['tunnel', '--url', origin, '--no-autoupdate', '--protocol', 'http2'], { stdio: 'inherit' });
tunnel.on('error', error => { console.error(error.message); process.exitCode = 1; });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  tunnel.kill('SIGTERM');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
tunnel.on('exit', code => { process.exitCode = stopping ? 0 : (code ?? 1); });
