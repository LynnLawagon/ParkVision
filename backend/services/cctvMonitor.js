const { randomUUID } = require('node:crypto');
const { CctvReader } = require('./cctvReader');
const { validateRegions, geometryMatches } = require('../validation');
const { checked, writeObservations } = require('./observations');

class CctvMonitor {
  constructor({ sources = [], worker, db, minimumConfidence = 0.8, ffmpeg = 'ffmpeg', configError = null,
    readerFactory, now = Date.now, intervalMs = 2000, maxAgeMs = 5000 } = {}) {
    this.worker = worker; this.db = db; this.minimumConfidence = minimumConfidence;
    this.configError = configError; this.now = now; this.intervalMs = intervalMs; this.maxAgeMs = maxAgeMs;
    this.readerFactory = readerFactory || ((source, callbacks) => new CctvReader(source, { ffmpeg, ...callbacks }));
    this.states = new Map(sources.map(source => [source.cameraId, { source, running: false, publishing: false,
      phase: 'stopped', reader: null, frame: null, sequence: 0, processedSequence: 0,
      generation: 0, retryAt: 0, backoff: 1000, lastAttempt: -Infinity, pending: null,
      lastAnalysis: null, lastPublication: null, error: null, analyzedFrames: 0, savedObservations: 0 }]));
  }
  status(id) {
    const state = this.states.get(id);
    if (!state) return { cameraId: id, configured: false, running: false, phase: 'not_configured' };
    const fresh = Boolean(state.frame && this.now() - state.frame.at <= this.maxAgeMs);
    return { cameraId: id, configured: true, kind: state.source.type === 'file' ? 'demo_replay' : 'cctv',
      running: state.running, publishing: state.publishing, phase: state.phase,
      connected: state.running && fresh, frameSequence: fresh ? state.frame.sequence : null,
      receivedAt: fresh ? new Date(state.frame.at).toISOString() : null,
      lastAnalysis: state.lastAnalysis, lastPublication: state.lastPublication,
      analyzedFrames: state.analyzedFrames, savedObservations: state.savedObservations, error: state.error };
  }
  frame(id) {
    const state = this.states.get(id);
    if (!state?.running || !state.frame || this.now() - state.frame.at > this.maxAgeMs) return null;
    return state.frame;
  }
  async start(id, { publish = false } = {}) {
    const state = this.states.get(id);
    if (!state) throw Object.assign(new Error('No server-side CCTV source is configured for this camera.'), { status: 400 });
    if (!this.db) throw Object.assign(new Error('Configure the backend database service key before starting CCTV monitoring.'), { status: 503 });
    if (state.running || state.starting) throw Object.assign(new Error('This camera is already monitoring or starting. Stop it before changing publication mode.'), { status: 409 });
    state.starting = true;
    const generation = ++state.generation;
    try {
      const camera = checked(await this.db.from('cameras').select('id, is_active').eq('id', id).single());
      if (state.generation !== generation) throw Object.assign(new Error('Camera start was cancelled.'), { status: 409 });
      if (!camera?.is_active) throw Object.assign(new Error('This camera is inactive.'), { status: 400 });
      state.running = true; state.publishing = publish;
      state.phase = 'connecting'; state.error = null; state.lastAttempt = -Infinity; state.backoff = 1000;
      this.connect(state);
      return this.status(id);
    } finally { if (state.generation === generation) state.starting = false; }
  }
  connect(state) {
    const generation = state.generation;
    state.connectAt = this.now(); state.phase = 'connecting';
    const reader = this.readerFactory(state.source, {
      onFrame: buffer => {
        if (!state.running || state.generation !== generation || state.reader !== reader) return;
        state.frame = { buffer, at: this.now(), sequence: ++state.sequence };
        state.backoff = 1000; state.phase = 'monitoring';
      },
      onDisconnect: message => {
        if (!state.running || state.generation !== generation || state.reader !== reader) return;
        reader.stop(); state.reader = null; state.frame = null;
        state.phase = 'reconnecting'; state.error = message;
        state.retryAt = this.now() + state.backoff; state.backoff = Math.min(30000, state.backoff * 2);
      },
    });
    state.reader = reader;
    reader.start();
  }
  async stop(id) {
    const state = this.states.get(id);
    if (!state) return this.status(id);
    state.running = false; state.starting = false; state.publishing = false; state.generation++;
    state.reader?.stop(); state.reader = null; state.frame = null; state.phase = 'stopped'; state.error = null;
    // Once Stop returns, a previous in-flight observation write is also finished.
    await state.pending?.catch(() => {});
    return this.status(id);
  }
  tick() {
    for (const state of this.states.values()) {
      if (!state.running) continue;
      if (!state.reader) {
        if (this.now() >= state.retryAt) this.connect(state);
        continue;
      }
      if (this.now() - (state.frame?.at ?? state.connectAt) > 12000) {
        state.reader.stop(); state.reader = null; state.frame = null;
        state.phase = 'reconnecting'; state.error = 'No fresh frames received. Reconnecting to this camera.';
        state.retryAt = this.now() + state.backoff; state.backoff = Math.min(30000, state.backoff * 2);
        continue;
      }
      if (state.pending || !this.frame(state.source.cameraId) || state.frame.sequence === state.processedSequence
        || this.now() - state.lastAttempt < this.intervalMs) continue;
      state.lastAttempt = this.now();
      state.pending = this.analyze(state).finally(() => { state.pending = null; });
    }
  }
  async analyze(state) {
    const generation = state.generation, frame = state.frame, id = state.source.cameraId;
    const current = () => state.running && state.generation === generation && this.now() - frame.at <= this.maxAgeMs;
    try {
      const camera = checked(await this.db.from('cameras').select('id, is_active').eq('id', id).maybeSingle());
      if (!current()) return;
      if (!camera?.is_active) { state.running = false; state.publishing = false; state.reader?.stop(); state.reader = null; state.frame = null; state.phase = 'inactive'; return; }
      const savedRegions = checked(await this.db.from('parking_regions').select('id, x, y, width, height').eq('camera_id', id).eq('is_active', true));
      if (!savedRegions.length) { state.phase = 'waiting_regions'; state.error = 'Save parking boxes against this camera view to begin classification.'; return; }
      const regions = validateRegions(savedRegions);
      if (!current()) return;
      const prediction = await this.worker.analyze({ image: frame.buffer.toString('base64'), regions, minimumConfidence: this.minimumConfidence });
      if (!current()) return;
      const saved = checked(await this.db.from('parking_regions').select('id, x, y, width, height').eq('camera_id', id).eq('is_active', true));
      const active = checked(await this.db.from('cameras').select('id, is_active').eq('id', id).maybeSingle());
      if (!current()) return;
      if (!active?.is_active || saved.length !== regions.length || !regions.every(region => saved.some(item => geometryMatches(region, item)))) {
        state.lastAnalysis = null; state.error = 'Camera or parking boxes changed during analysis. Waiting for a fresh frame.'; return;
      }
      state.processedSequence = frame.sequence; state.analyzedFrames++;
      state.lastAnalysis = { ...prediction, capturedAt: new Date(frame.at).toISOString(),
        savedRegions: true, canPublish: false, sourceKind: state.source.type === 'file' ? 'demo_replay' : 'cctv' };
      state.phase = 'monitoring'; state.error = null;
      if (state.publishing && current()) {
        const accepted = prediction.results.filter(item => !item.requiresReview);
        state.lastPublication = await writeObservations(this.db, { frameId: randomUUID(), cameraId: id,
          capturedAt: state.lastAnalysis.capturedAt, accepted, skipped: prediction.results.length - accepted.length });
        state.savedObservations += state.lastPublication.saved;
      }
    } catch {
      if (state.running && state.generation === generation) {
        state.phase = 'analysis_error';
        state.error = 'Frame analysis or database publication failed. Check model readiness, saved regions, and the database connection; the next fresh frame will be retried.';
      }
    }
  }
  async startConfigured() {
    for (const state of this.states.values()) if (state.source.autoStart) {
      try { await this.start(state.source.cameraId, { publish: state.source.publish }); }
      catch { state.error = 'Could not auto-start this configured camera. Check its database record and backend configuration.'; state.phase = 'start_error'; }
    }
    this.timer = setInterval(() => this.tick(), 250); this.timer.unref();
  }
  async close() {
    clearInterval(this.timer);
    await Promise.all([...this.states.keys()].map(id => this.stop(id)));
  }
}
module.exports = { CctvMonitor };
