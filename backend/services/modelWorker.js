const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const config = require('../config');
class ModelWorker {
  constructor(options = {}) {
    this.python = options.python || config.python;
    this.modelPath = options.modelPath || config.modelPath;
    this.child = null;
    this.pending = new Map();
    this.status = { state: 'stopped', model: null, error: null };
  }
  start() {
    if (this.child) return;
    this.status = { state: 'loading', model: null, error: null };
    const child = spawn(this.python, ['-u', path.resolve(__dirname, '../../ml/worker.py'), this.modelPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const startup = setTimeout(() => this.fail('Model startup timed out. Check Python and MODEL_PATH.'), 120000);
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === 'ready') {
        clearTimeout(startup);
        this.status = { state: 'ready', model: message.model, error: null };
      } else if (message.type === 'fatal') { clearTimeout(startup); this.fail(message.error); }
      else {
        const job = this.pending.get(message.id);
        if (!job) return;
        clearTimeout(job.timer);
        this.pending.delete(message.id);
        message.error ? job.reject(Object.assign(new Error(message.error), { status: 400 })) : job.resolve(message.result);
      }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => this.fail('Could not communicate with the model. Restart the backend.'));
    child.on('error', () => { clearTimeout(startup); this.fail('Python could not start. Set ML_PYTHON to your ML environment executable.'); });
    child.on('exit', () => {
      clearTimeout(startup);
      if (this.child === child) {
        this.child = null;
        if (this.status.state !== 'error') this.fail('Inference process stopped. Restart the backend.');
      }
    });
  }
  fail(error) {
    this.status = { ...this.status, state: 'error', error };
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new Error(error)); }
    this.pending.clear();
    const child = this.child;
    this.child = null;
    child?.kill();
  }
  async analyze(payload) {
    if (this.status.state !== 'ready') throw Object.assign(new Error(this.status.error || 'Model is still loading. Try again shortly.'), { status: 503 });
    if (this.pending.size) throw Object.assign(new Error('An image is already being analyzed. Wait for it to finish.'), { status: 429 });
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => this.fail('Inference timed out. Restart the backend.'), 45000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, payload }) + '\n', error => { if (error) this.fail('Could not send the image to the model.'); });
    });
  }
  stop() { this.fail('Inference stopped.'); }
}
module.exports = { ModelWorker };
