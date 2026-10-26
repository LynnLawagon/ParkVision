const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const { rateLimit } = require('express-rate-limit');
const config = require('./config');
const db = require('./services/supabase');
const { requireAuth, requireAdmin } = require('./middleware/requireAuth');
const { inferenceRoutes } = require('./routes/inference');
const { validateRegions } = require('./validation');
const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
const unwrap = response => { if (response.error) throw Object.assign(new Error(response.error.message), { status: 502 }); return response.data; };

function createApp(options = {}) {
  const worker = options.worker;
  const publicClient = options.publicClient === undefined ? db.publicClient : options.publicClient;
  const serviceClient = options.serviceClient === undefined ? db.serviceClient : options.serviceClient;
  const authorize = options.authorize || requireAuth;
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.origin }));
  app.use(express.json({ limit: '100kb' }));
  app.get('/api/config', (req, res) => res.json({
    supabaseUrl: config.supabaseUrl || '', publishableKey: config.publishableKey || '',
    configured: Boolean(publicClient), writeEnabled: Boolean(serviceClient),
    minimumConfidence: config.minimumConfidence, model: worker.status,
  }));
  app.get('/api/health', (req, res) => res.json({ ok: true, configured: Boolean(publicClient), writeEnabled: Boolean(serviceClient), model: worker.status }));
  app.get('/api/connection', wrap(async (req, res) => {
    if (!publicClient) return res.status(503).json({ error: 'Fill in backend/.env using backend/.env.example, then restart the backend.' });
    const lots = unwrap(await publicClient.from('parking_lots').select('id').limit(1));
    unwrap(await publicClient.from('parking_summary').select('total').limit(1));
    res.json({ ok: true, hasLayout: lots.length > 0 });
  }));
  app.get('/api/stalls', wrap(async (req, res) => {
    if (!publicClient) return res.status(503).json({ error: 'Configure Supabase first.' });
    res.json(unwrap(await publicClient.from('parking_status').select('*')));
  }));
  app.get('/api/stalls/summary', wrap(async (req, res) => {
    if (!publicClient) return res.status(503).json({ error: 'Configure Supabase first.' });
    res.json(unwrap(await publicClient.from('parking_summary').select('*')));
  }));
  app.get('/api/regions/log', authorize, requireAdmin, wrap(async (req, res) => res.json(unwrap(await req.db.from('region_change_log').select('*').order('changed_at', { ascending: false }).limit(100)))));
  app.get('/api/regions', authorize, wrap(async (req, res) => res.json(unwrap(await req.db.from('parking_regions').select('*').eq('is_active', true)))));
  app.post('/api/regions', authorize, requireAdmin, wrap(async (req, res) => {
    const { randomUUID } = require('node:crypto');
    const region = validateRegions([{ ...req.body, id: req.body.id || randomUUID() }])[0];
    res.status(201).json(unwrap(await req.db.from('parking_regions').insert({ ...region, camera_id: req.body.camera_id, parking_space_id: req.body.parking_space_id }).select().single()));
  }));
  app.patch('/api/regions/:id', authorize, requireAdmin, wrap(async (req, res) => {
    const current = unwrap(await req.db.from('parking_regions').select('*').eq('id', req.params.id).single());
    const region = validateRegions([{ ...current, ...req.body, id: current.id }])[0];
    res.json(unwrap(await req.db.from('parking_regions').update({ x: region.x, y: region.y, width: region.width, height: region.height }).eq('id', current.id).select().single()));
  }));
  app.delete('/api/regions/:id', authorize, requireAdmin, wrap(async (req, res) => {
    unwrap(await req.db.from('parking_regions').update({ is_active: false }).eq('id', req.params.id));
    res.status(204).end();
  }));
  app.get('/api/alerts', authorize, wrap(async (req, res) => res.json(unwrap(await req.db.from('obstruction_alerts').select('*, alert_acknowledgements(*)').is('resolution_observation_id', null)))));
  app.post('/api/alerts/:id/acknowledge', authorize, wrap(async (req, res) => res.json(unwrap(await req.db.rpc('acknowledge_alert', { p_alert_id: req.params.id })))));
  app.use('/api/inference', rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'Too many analysis requests. Wait a minute, then try again.' }),
  }), inferenceRoutes({ worker, authorize, serviceClient, minimumConfidence: config.minimumConfidence }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
  const dist = path.resolve(__dirname, '../frontend/dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : error.status || (error.name === 'MulterError' ? 400 : 500);
    res.status(status).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Image must be smaller than 8 MB.' : error.message || 'Request failed.' });
  });
  return app;
}
module.exports = { createApp };
