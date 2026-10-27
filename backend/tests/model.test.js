const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const config = require('../config');
const { ModelWorker } = require('../services/modelWorker');
const source = process.env.ML_TEST_IMAGE || path.join(os.homedir(), 'Downloads', 'att.kEohp7BzXo0SP9pkA7B3RvQYQI960uS6vOdUbdzv2-I.JPG');
test('installed model obeys the binary inference/review contract on a real photo', { skip: !fs.existsSync(config.python) || !fs.existsSync(config.modelPath) || !fs.existsSync(source), timeout: 120000 }, async t => {
  const worker = new ModelWorker(); t.after(() => worker.stop()); worker.start();
  while (worker.status.state === 'loading') await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(worker.status.state, 'ready', worker.status.error);
  const child = worker.child;
  const result = await worker.analyze({ image: fs.readFileSync(source).toString('base64'), minimumConfidence: 0.8, regions: [{ id: 'empty-left', x: 0.08, y: 0.45, width: 0.38, height: 0.5 }] });
  assert.equal(result.results.length, 1);
  const prediction = result.results[0];
  assert.ok(Number.isFinite(prediction.occupancyScore) && prediction.occupancyScore >= 0 && prediction.occupancyScore <= 1);
  assert.equal(prediction.status, prediction.occupancyScore >= 0.5 ? 'occupied' : 'vacant');
  assert.equal(prediction.confidence, Math.max(prediction.occupancyScore, 1 - prediction.occupancyScore));
  assert.equal(prediction.requiresReview, prediction.confidence < 0.8);
  // Preserve the diagnosed S2 regression only for those exact weights. A new
  // trained model is allowed to correct the old false-positive result.
  if (result.model.version === '8ab6c670359b') {
    assert.equal(prediction.status, 'occupied');
    assert.ok(Math.abs(prediction.occupancyScore - 0.6179634) < 0.01);
    assert.equal(prediction.requiresReview, true);
  }
  await assert.rejects(worker.analyze({ image: 'not-an-image', regions: [{ id: 'bad', x: 0, y: 0, width: 0.5, height: 0.5 }] }));
  assert.equal(worker.child, child, 'the model stays loaded between requests and after bad input');
});
