const { spawn } = require('node:child_process');
const START = Buffer.from([0xff, 0xd8]), END = Buffer.from([0xff, 0xd9]);
const MAX_FRAME = 8 * 1024 * 1024;

function decoderArgs(source) {
  const input = source.type === 'rtsp'
    ? ['-rtsp_transport', 'tcp', '-timeout', '10000000']
    : ['-re', '-stream_loop', '-1'];
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', ...input, '-i', source.source,
    '-an', '-sn', '-dn', '-vf', "fps=2,scale='min(1280,iw)':-2", '-threads', '1',
    '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1'];
}

class CctvReader {
  constructor(source, { ffmpeg = 'ffmpeg', onFrame, onDisconnect, spawnProcess = spawn } = {}) {
    this.source = source; this.ffmpeg = ffmpeg; this.onFrame = onFrame;
    this.onDisconnect = onDisconnect; this.spawnProcess = spawnProcess;
    this.buffer = Buffer.alloc(0); this.closed = false; this.child = null;
  }
  start() {
    this.child = this.spawnProcess(this.ffmpeg, decoderArgs(this.source), { stdio: ['ignore', 'pipe', 'ignore'] });
    this.child.stdout.on('data', chunk => this.consume(chunk));
    // Do not forward decoder stderr/URLs: streams can contain camera passwords.
    this.child.once('error', () => this.disconnected('Camera decoder could not start. Check that FFmpeg is installed.'));
    this.child.once('close', () => this.disconnected('Camera stream disconnected. Check network access, stream address, and camera login.'));
  }
  consume(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const start = this.buffer.indexOf(START);
      if (start === -1) { this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 1)); return; }
      if (start) this.buffer = this.buffer.subarray(start);
      const end = this.buffer.indexOf(END, 2);
      if (end === -1) {
        if (this.buffer.length > MAX_FRAME) { this.disconnected('Camera frame exceeded the 8 MB limit. Use a lower-resolution stream.'); this.stop(); }
        return;
      }
      const frame = this.buffer.subarray(0, end + 2);
      this.buffer = this.buffer.subarray(end + 2);
      if (frame.length <= MAX_FRAME) this.onFrame(Buffer.from(frame));
    }
  }
  disconnected(message) {
    if (this.closed) return;
    this.closed = true; this.buffer = Buffer.alloc(0); this.onDisconnect(message);
  }
  stop() {
    this.closed = true; this.buffer = Buffer.alloc(0);
    const child = this.child;
    if (!child) return;
    child.kill('SIGTERM');
    const kill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
    kill.unref(); child.once('close', () => clearTimeout(kill));
  }
}
module.exports = { CctvReader, decoderArgs };
