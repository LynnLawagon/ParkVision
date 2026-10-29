import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveStatus, isRecentFrame } from '../src/lib/parkingStatus.js';
import { createFrameMonitor } from '../src/lib/frameMonitor.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const result = { canPublish: true, results: [{ status: 'blocked', requiresReview: false }] };
const defaults = () => ({ shouldContinue: () => true, capture: async () => ({}), analyze: async () => result, onError: error => { throw error; }, onStop() {} });

test('availability expires on the clock without another database response', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  const space = { observed_at: new Date(now).toISOString(), status: 'vacant', is_stale: false };
  assert.equal(effectiveStatus(space, now + 9999), 'vacant');
  assert.equal(effectiveStatus(space, now + 10000), 'unknown');
  for (const status of ['occupied', 'blocked']) assert.equal(effectiveStatus({ ...space, status }, now), status);
  for (const changes of [{ observed_at: 'invalid' }, { observed_at: null }, { status: 'invalid' }, { is_stale: true }, { observed_at: new Date(now + 30000).toISOString() }]) {
    assert.equal(effectiveStatus({ ...space, ...changes }, now), 'unknown');
  }
  assert.equal(isRecentFrame('invalid', now), false);
});

test('stopping pending inference prevents its automatic publication', async () => {
  const monitor = createFrameMonitor();
  const started = deferred(), pending = deferred();
  let published = 0, stopped = 0;
  const run = monitor.start({ ...defaults(), analyze: () => { started.resolve(); return pending.promise; }, publish: async () => { published++; }, onStop: () => { stopped++; } });
  await started.promise;
  monitor.stop(); pending.resolve(result); await run;
  assert.equal(published, 0); assert.equal(stopped, 1); assert.equal(monitor.running, false);
});

test('an old run finishing cannot stop or publish for a replacement run', async () => {
  const monitor = createFrameMonitor();
  const oldStarted = deferred(), oldPending = deferred(), newStarted = deferred(), newPending = deferred();
  let newStopped = 0, published = 0;
  const oldRun = monitor.start({ ...defaults(), analyze: () => { oldStarted.resolve(); return oldPending.promise; }, publish: async () => { published++; } });
  await oldStarted.promise; monitor.stop();
  const newRun = monitor.start({ ...defaults(), analyze: () => { newStarted.resolve(); return newPending.promise; }, onStop: () => { newStopped++; } });
  await newStarted.promise; oldPending.resolve(result); await oldRun;
  assert.equal(monitor.running, true); assert.equal(newStopped, 0); assert.equal(published, 0);
  monitor.stop(); newPending.resolve(result); await newRun;
  assert.equal(newStopped, 1);
});

test('pausing or ending playback during inference suppresses publication', async () => {
  const monitor = createFrameMonitor(); let playing = true, published = false;
  await monitor.start({ ...defaults(), shouldContinue: () => playing, analyze: async () => { playing = false; return result; }, publish: async () => { published = true; } });
  assert.equal(published, false); assert.equal(monitor.running, false);
});

test('preview-only and all-review runs do not publish; accepted results publish once per frame', async () => {
  for (const mode of ['preview', 'review', 'accepted']) {
    let frames = 0, published = 0;
    const monitor = createFrameMonitor(async () => { frames++; });
    await monitor.start({ ...defaults(), shouldContinue: () => frames < 3,
      capture: async () => ({}),
      analyze: async () => mode === 'review' ? { ...result, results: [{ requiresReview: true }] } : result,
      publish: mode === 'preview' ? undefined : async () => { published++; },
    });
    assert.equal(published, mode === 'accepted' ? 3 : 0);
  }
});

test('stopping capture skips analysis and duplicate starts cannot create a second loop', async () => {
  const monitor = createFrameMonitor(); const started = deferred(), pending = deferred(); let analyzed = 0;
  const run = monitor.start({ ...defaults(), capture: () => { started.resolve(); return pending.promise; }, analyze: async () => { analyzed++; return result; } });
  await started.promise;
  await monitor.start({ ...defaults(), capture: () => assert.fail('duplicate capture') });
  monitor.stop(); pending.resolve({}); await run;
  assert.equal(analyzed, 0);
});
