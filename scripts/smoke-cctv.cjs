// Real FFmpeg + real installed model; all observation writes stay in memory.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { ModelWorker } = require('../backend/services/modelWorker');
const { InferenceQueue } = require('../backend/services/inferenceQueue');
const { CctvMonitor } = require('../backend/services/cctvMonitor');
const { memoryDb } = require('../backend/tests/helpers/memoryDb');
async function main() {
  const video = path.resolve(process.argv[2] || 'output/cctv-demo/parking-demo.mp4');
  assert.ok(fs.existsSync(video), 'Prepare the two-photo demo with python3 scripts/prepare-cctv-demo.py first.');
  const ids = [randomUUID(), randomUUID()];
  const tables = { cameras: ids.map(id => ({ id, is_active: true })),
    parking_regions: [
      { id: randomUUID(), camera_id: ids[0], is_active: true, x: .005489, y: .014714, width: .454832, height: .985286 },
      { id: randomUUID(), camera_id: ids[1], is_active: true, x: .4686, y: .012926, width: .5314, height: .987074 },
    ], camera_frames: [], space_observations: [] };
  const worker = new InferenceQueue(new ModelWorker());
  const monitor = new CctvMonitor({ worker, db: memoryDb(tables), sources: ids.map(cameraId => ({ cameraId, type: 'file', source: video })) });
  worker.start();
  try {
    const timeout = Date.now() + 120000;
    while (worker.status.state === 'loading' && Date.now() < timeout) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(worker.status.state, 'ready', worker.status.error);
    console.log('Installed model:', worker.status.model.name, worker.status.model.version);
    await monitor.startConfigured();
    for (const id of ids) await monitor.start(id, { publish: true });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const left = tables.space_observations.filter(item => item.parking_region_id === tables.parking_regions[0].id);
      const right = tables.space_observations.filter(item => item.parking_region_id === tables.parking_regions[1].id);
      if (left.some(item => item.status === 'occupied') && left.some(item => item.status === 'vacant') && right.length >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const left = tables.space_observations.filter(item => item.parking_region_id === tables.parking_regions[0].id);
    const right = tables.space_observations.filter(item => item.parking_region_id === tables.parking_regions[1].id);
    console.log('Camera 1 (left space):', left.map(item => item.status));
    console.log('Camera 2 (SUV space):', right.map(item => item.status));
    assert.ok(left.some(item => item.status === 'occupied') && left.some(item => item.status === 'vacant'), 'Left space should change occupied → vacant in the two-photo fixture.');
    assert.ok(right.length >= 2 && right.every(item => item.status === 'occupied'), 'SUV space should stay occupied.');
    for (const frame of tables.camera_frames) {
      const observation = tables.space_observations.find(item => item.camera_frame_id === frame.id);
      assert.equal(tables.parking_regions.find(region => region.id === observation.parking_region_id).camera_id, frame.camera_id);
    }
    await monitor.close();
    const count = tables.space_observations.length;
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(tables.space_observations.length, count);
    assert.equal(monitor.frame(ids[0]), null);
    console.log('PASS: two independent background sources, real decoding/inference, accepted publication, and Stop cleanup.');
    console.log('All writes used an in-memory database. No hosted Supabase rows were changed. Real CCTV hardware remains untested.');
  } finally { await monitor.close(); worker.stop(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
