const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CctvMonitor } = require('../services/cctvMonitor');
const { CctvReader, decoderArgs } = require('../services/cctvReader');
const { InferenceQueue } = require('../services/inferenceQueue');
const { loadSources } = require('../services/cctvSources');
const { memoryDb } = require('./helpers/memoryDb');
const { createApp } = require('../app');

function fixture() {
  let now = 100000;
  const ids = [randomUUID(), randomUUID()], readers = new Map();
  const tables = { cameras: ids.map(id => ({ id, is_active: true })),
    parking_regions: ids.flatMap(camera_id => [0, 1].map((_, i) => ({ id: randomUUID(), camera_id, is_active: true, x: i * 0.5, y: 0, width: 0.4, height: 0.8 }))), camera_frames: [], space_observations: [] };
  const db = memoryDb(tables);
  const worker = { status: { state: 'ready' }, async analyze(payload) {
    return { model: { name: 'fixture' }, results: payload.regions.map((region, i) => ({ regionId: region.id, status: 'occupied', occupancyScore: i ? 0.6 : 0.95, confidence: i ? 0.6 : 0.95, requiresReview: Boolean(i) })) };
  } };
  const monitor = new CctvMonitor({ db, worker, now: () => now, sources: ids.map(cameraId => ({ cameraId, type: 'rtsp', source: 'rtsp://user:camera-secret@camera.invalid/live' })),
    readerFactory(source, callbacks) {
      const reader = { start() {}, stop() {}, ...callbacks }; readers.set(source.cameraId, reader); return reader;
    } });
  const frame = id => readers.get(id).onFrame(Buffer.from('jpeg-fixture'));
  const settle = () => Promise.all([...monitor.states.values()].map(state => state.pending));
  return { ids, tables, db, worker, monitor, readers, frame, settle, advance(ms) { now += ms; } };
}

test('private CCTV sources validate IDs/protocols without echoing stream credentials', t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'cctv-config-')); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const filename = path.join(folder, 'sources.json');
  assert.deepEqual(loadSources(filename), []);
  const entry = { cameraId: randomUUID(), type: 'rtsp', source: 'rtsp://user:private-secret@192.168.1.20/live' };
  writeFileSync(filename, JSON.stringify([entry]));
  assert.equal(loadSources(filename)[0].publish, false);
  writeFileSync(filename, JSON.stringify([entry, entry]));
  assert.throws(() => loadSources(filename), error => !error.message.includes('private-secret'));
  writeFileSync(filename, JSON.stringify([{ ...entry, source: 'https://invalid.example/live' }]));
  assert.throws(() => loadSources(filename));
});
test('decoder handles fragmented JPEG frames and uses bounded RTSP TCP reads', () => {
  const frames = [];
  const reader = new CctvReader({}, { onFrame: frame => frames.push(frame), onDisconnect() {} });
  reader.consume(Buffer.from([1, 0xff])); reader.consume(Buffer.from([0xd8, 4, 5, 0xff]));
  reader.consume(Buffer.from([0xd9, 0xff, 0xd8, 6, 0xff, 0xd9]));
  assert.deepEqual(frames.map(frame => [...frame]), [[0xff, 0xd8, 4, 5, 0xff, 0xd9], [0xff, 0xd8, 6, 0xff, 0xd9]]);
  assert.ok(decoderArgs({ type: 'rtsp', source: 'rtsp://camera/live' }).includes('tcp'));
  assert.ok(decoderArgs({ type: 'file', source: '/tmp/demo.mp4' }).includes('-re'));
});
test('one loaded model serves simultaneous cameras in order and expires old queued requests', async () => {
  let release, active = 0, maximum = 0;
  const queue = new InferenceQueue({ status: { state: 'ready' }, async analyze(value) {
    active++; maximum = Math.max(maximum, active);
    if (value === 1) await new Promise(resolve => { release = resolve; });
    active--; return value;
  }, stop() {} }, { waitMs: 20 });
  const first = queue.analyze(1);
  const expired = assert.rejects(queue.analyze(2), /waited too long/);
  await expired; release(); assert.equal(await first, 1);
  assert.deepEqual(await Promise.all([queue.analyze(3), queue.analyze(4)]), [3, 4]);
  assert.equal(maximum, 1); queue.stop(); await assert.rejects(queue.analyze(5), /stopped/);
});
test('two background cameras publish their own regions, skip review, and never repeat an old frame', async () => {
  const f = fixture();
  for (const id of f.ids) { await f.monitor.start(id, { publish: true }); f.frame(id); }
  f.monitor.tick(); await f.settle();
  assert.equal(f.tables.camera_frames.length, 2); assert.equal(f.tables.space_observations.length, 2);
  for (const frame of f.tables.camera_frames) {
    const observation = f.tables.space_observations.find(item => item.camera_frame_id === frame.id);
    assert.equal(f.tables.parking_regions.find(region => region.id === observation.parking_region_id).camera_id, frame.camera_id);
  }
  f.advance(3000); f.monitor.tick(); await f.settle();
  assert.equal(f.tables.space_observations.length, 2);
  f.advance(3000); assert.equal(f.monitor.frame(f.ids[0]), null);
  assert.equal(f.monitor.status(f.ids[0]).connected, false);
  await f.monitor.close();
});
test('preview mode performs inference without hosted writes and reconnect clears stale frames', async () => {
  const f = fixture(), id = f.ids[0];
  await f.monitor.start(id); f.frame(id); f.monitor.tick(); await f.settle();
  assert.equal(f.monitor.status(id).analyzedFrames, 1);
  assert.equal(f.tables.camera_frames.length, 0);
  f.readers.get(id).onDisconnect('Network lost');
  assert.equal(f.monitor.frame(id), null); assert.equal(f.monitor.status(id).phase, 'reconnecting');
  const old = f.readers.get(id); f.advance(1100); f.monitor.tick();
  assert.notEqual(f.readers.get(id), old);
  old.onFrame(Buffer.from('old')); assert.equal(f.monitor.frame(id), null);
  await f.monitor.close();
});
test('simultaneous starts create one decoder and Stop cancels a pending start', async () => {
  const f = fixture(), id = f.ids[0];
  const first = f.monitor.start(id);
  await assert.rejects(f.monitor.start(id), /already monitoring or starting/);
  await first; await f.monitor.stop(id);
  const cancelled = f.monitor.start(id);
  const rejection = assert.rejects(cancelled, /cancelled/);
  await f.monitor.stop(id); await rejection;
  assert.equal(f.monitor.status(id).running, false);
});
test('stopping or recalibrating during inference prevents that result from being published', async () => {
  for (const action of ['stop', 'calibrate']) {
    const f = fixture(), id = f.ids[0]; let release;
    const original = f.worker.analyze;
    f.worker.analyze = async payload => { await new Promise(resolve => { release = resolve; }); return original(payload); };
    await f.monitor.start(id, { publish: true }); f.frame(id); f.monitor.tick();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    let stopped;
    if (action === 'stop') stopped = f.monitor.stop(id);
    else f.tables.parking_regions[0].width = 0.3;
    release(); await f.settle(); await stopped;
    assert.equal(f.tables.space_observations.length, 0, action);
    await f.monitor.close();
  }
});
test('CCTV status/frames require sign-in, controls require admin, and status never exposes source logins', async t => {
  const f = fixture();
  const authorize = (req, res, next) => {
    const role = req.headers.authorization;
    if (!role) return res.status(401).json({ error: 'Sign in required.' });
    req.profile = { role_code: role === 'admin' ? 'parking_administrator' : 'parking_personnel' }; req.db = f.db; next();
  };
  const server = createApp({ worker: f.worker, monitor: f.monitor, authorize, publicClient: null, serviceClient: f.db }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await f.monitor.close(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/cctv`;
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(`${base}/${f.ids[0]}/frame`)).status, 401);
  const status = await (await fetch(base, { headers: { Authorization: 'personnel' } })).text();
  assert.ok(!status.includes('camera-secret') && !status.includes('rtsp://'));
  assert.equal((await fetch(`${base}/${f.ids[0]}/start`, { method: 'POST', headers: { Authorization: 'personnel' } })).status, 403);
  assert.equal((await fetch(`${base}/${f.ids[0]}/start`, { method: 'POST', headers: { Authorization: 'admin', 'Content-Type': 'application/json' }, body: '{"publish":false}' })).status, 200);
  f.frame(f.ids[0]);
  const frame = await fetch(`${base}/${f.ids[0]}/frame`, { headers: { Authorization: 'personnel' } });
  assert.equal(frame.status, 200); assert.equal(frame.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${base}/${f.ids[0]}/stop`, { method: 'POST', headers: { Authorization: 'admin' } })).status, 200);
});
