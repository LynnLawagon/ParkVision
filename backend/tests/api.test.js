const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createApp } = require('../app');
const { createRequireAuth, requireAdmin } = require('../middleware/requireAuth');
const { validateRegions } = require('../validation');

function memoryDb(tables) {
  return { from(table) {
    let operation = 'select', values, single = false;
    const filters = [];
    const builder = {
      select() { return builder; }, eq(key, value) { filters.push(row => row[key] === value); return builder; },
      maybeSingle() { single = true; return builder; }, single() { single = true; return builder; },
      insert(data) { operation = 'insert'; values = data; return builder; },
      update(data) { operation = 'update'; values = data; return builder; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          tables[table] ||= [];
          if (operation === 'insert') tables[table].push(...(Array.isArray(values) ? values : [values]));
          let rows = tables[table].filter(row => filters.every(filter => filter(row)));
          if (operation === 'update') rows.forEach(row => Object.assign(row, values));
          return { data: single ? rows[0] || null : rows, error: null };
        }).then(resolve, reject);
      },
    };
    return builder;
  } };
}
function response() {
  return { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
test('auth verifies the token with Supabase and rejects an unapproved profile', async () => {
  let verified;
  const auth = createRequireAuth({ auth: { async getUser(token) { verified = token; return { data: { user: { id: 'user' } }, error: null }; } } }, () => memoryDb({ profiles: [{ id: 'user', role_code: null }] }));
  const res = response(); let next = false;
  await auth({ headers: { authorization: 'Bearer signed-token' } }, res, () => { next = true; });
  assert.equal(verified, 'signed-token'); assert.equal(res.code, 403); assert.equal(next, false);
});
test('auth rejects invalid credentials and permits approved personnel', async () => {
  const invalid = createRequireAuth({ auth: { async getUser() { return { data: { user: null }, error: new Error('invalid') }; } } });
  const denied = response(); await invalid({ headers: { authorization: 'Bearer invalid' } }, denied, () => assert.fail('must not continue'));
  assert.equal(denied.code, 401);
  const approved = createRequireAuth({ auth: { async getUser() { return { data: { user: { id: 'user' } }, error: null }; } } }, () => memoryDb({ profiles: [{ id: 'user', role_code: 'parking_personnel' }] }));
  let passed = false; const req = { headers: { authorization: 'Bearer valid' } };
  await approved(req, response(), () => { passed = true; }); assert.equal(passed, true);
  const adminOnly = response(); requireAdmin(req, adminOnly, () => assert.fail('personnel must not configure')); assert.equal(adminOnly.code, 403);
});
test('region validation rejects invalid geometry and duplicate IDs', () => {
  const region = { id: randomUUID(), x: 0, y: 0, width: 0.3, height: 0.4 };
  assert.throws(() => validateRegions([{ ...region, width: -1 }]));
  assert.throws(() => validateRegions([{ ...region, x: 0.9 }]));
  assert.throws(() => validateRegions([region, region]));
  assert.throws(() => validateRegions([{ ...region, width: '0.3' }]));
});

async function fixture(t) {
  const cameraId = randomUUID(), good = randomUUID(), uncertain = randomUUID();
  const regions = [{ id: good, camera_id: cameraId, is_active: true, x: 0, y: 0, width: 0.4, height: 0.8 }, { id: uncertain, camera_id: cameraId, is_active: true, x: 0.5, y: 0, width: 0.4, height: 0.8 }];
  const tables = { cameras: [{ id: cameraId, is_active: true }], parking_regions: regions, camera_frames: [], space_observations: [] };
  const db = memoryDb(tables);
  let modelCalls = 0;
  const worker = { status: { state: 'ready', model: { name: 'test' } }, async analyze(payload) {
    modelCalls++;
    return { results: payload.regions.map((region, i) => ({ regionId: region.id, status: 'occupied', confidence: i ? 0.62 : 0.95, occupancyScore: i ? 0.62 : 0.95, requiresReview: i > 0 })) };
  } };
  const authorize = (req, res, next) => {
    const role = req.headers.authorization?.slice(7);
    if (!role) return res.status(401).json({ error: 'Sign in required.' });
    req.user = { id: role === 'other' ? 'other' : 'user' };
    req.profile = { role_code: role === 'admin' ? 'parking_administrator' : 'parking_personnel' };
    req.db = db; next();
  };
  const server = createApp({ worker, publicClient: null, serviceClient: db, authorize }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function analyze(role = 'admin', selected = regions) {
    const form = new FormData(); form.append('image', new Blob(['test'], { type: 'image/jpeg' }), 'frame.jpg');
    form.append('cameraId', cameraId); form.append('regions', JSON.stringify(selected));
    const result = await fetch(`${base}/api/inference/analyze`, { method: 'POST', headers: role ? { Authorization: `Bearer ${role}` } : {}, body: form });
    return { status: result.status, body: await result.json() };
  }
  async function publish(id, role = 'admin') {
    const result = await fetch(`${base}/api/inference/publish`, { method: 'POST', headers: { Authorization: `Bearer ${role}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ analysisId: id }) });
    return { status: result.status, body: await result.json() };
  }
  return { analyze, publish, tables, regions, base, modelCalls: () => modelCalls };
}
test('unauthenticated inference is denied and the old unauthenticated write route is gone', async t => {
  const f = await fixture(t);
  assert.equal((await f.analyze(null)).status, 401); assert.equal(f.modelCalls(), 0);
  assert.equal((await fetch(`${f.base}/api/stalls/A1`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"status":"vacant"}' })).status, 404);
});
test('personnel cannot preview tampered regions and no preview can publish unsaved geometry', async t => {
  const f = await fixture(t);
  const changed = f.regions.map(region => ({ ...region, x: region.x + 0.01 }));
  assert.equal((await f.analyze('personnel', changed)).status, 403);
  const preview = await f.analyze('admin', changed);
  assert.equal(preview.status, 200); assert.equal(preview.body.savedRegions, false);
  assert.equal((await f.publish(preview.body.analysisId)).status, 400);
  assert.equal(f.tables.space_observations.length, 0);
});
test('publishing skips review predictions, is owner-bound, and is idempotent', async t => {
  const f = await fixture(t);
  const preview = await f.analyze(); assert.equal(preview.status, 200);
  assert.equal((await f.publish(preview.body.analysisId, 'other')).status, 400);
  const saved = await f.publish(preview.body.analysisId);
  assert.equal(saved.status, 200); assert.equal(saved.body.saved, 1); assert.equal(saved.body.skipped, 1);
  assert.equal(f.tables.camera_frames.length, 1); assert.equal(f.tables.space_observations.length, 1);
  assert.equal(f.tables.space_observations[0].confidence, 0.95);
  assert.deepEqual((await f.publish(preview.body.analysisId)).body, saved.body);
  assert.equal(f.tables.space_observations.length, 1);
});
test('changing a saved region invalidates an earlier preview', async t => {
  const f = await fixture(t); const preview = await f.analyze();
  f.tables.parking_regions[0].x = 0.02;
  assert.equal((await f.publish(preview.body.analysisId)).status, 400);
  assert.equal(f.tables.space_observations.length, 0);
});
test('configuration response never includes the server key', async t => {
  const f = await fixture(t); const config = await (await fetch(`${f.base}/api/config`)).json();
  assert.equal(config.writeEnabled, true);
  assert.equal('serviceKey' in config, false); assert.equal('serviceRoleKey' in config, false);
});
