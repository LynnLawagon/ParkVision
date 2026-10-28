// Share one loaded model between background cameras and interactive previews.
class InferenceQueue {
  constructor(worker, { limit = 16, waitMs = 5000 } = {}) {
    this.worker = worker; this.limit = limit; this.waitMs = waitMs;
    this.queue = []; this.busy = false; this.closed = false;
  }
  get status() { return this.worker.status; }
  start() { this.worker.start(); }
  analyze(payload) {
    if (this.closed) return Promise.reject(new Error('Inference stopped.'));
    if (this.queue.length >= this.limit) return Promise.reject(Object.assign(new Error('Camera analysis queue is full. Try again shortly.'), { status: 429 }));
    return new Promise((resolve, reject) => {
      const job = { payload, resolve, reject };
      job.timer = setTimeout(() => {
        const index = this.queue.indexOf(job);
        if (index !== -1) { this.queue.splice(index, 1); reject(Object.assign(new Error('Camera analysis waited too long. A fresh frame is needed.'), { status: 429 })); }
      }, this.waitMs);
      this.queue.push(job); this.pump();
    });
  }
  async pump() {
    if (this.busy || this.closed) return;
    const job = this.queue.shift();
    if (!job) return;
    clearTimeout(job.timer); this.busy = true;
    try { job.resolve(await this.worker.analyze(job.payload)); }
    catch (error) { job.reject(error); }
    finally { this.busy = false; this.pump(); }
  }
  stop() {
    this.closed = true;
    for (const job of this.queue.splice(0)) { clearTimeout(job.timer); job.reject(new Error('Inference stopped.')); }
    this.worker.stop();
  }
}
module.exports = { InferenceQueue };
