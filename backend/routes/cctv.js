const express = require('express');
const { requireAdmin } = require('../middleware/requireAuth');
const { UUID, badRequest } = require('../validation');
const { checked } = require('../services/observations');
const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function cctvRoutes({ monitor, authorize }) {
  const router = express.Router();
  router.use(authorize);
  router.get('/', wrap(async (req, res) => {
    const cameras = checked(await req.db.from('cameras').select('id').eq('is_active', true));
    res.set('Cache-Control', 'no-store').json({ error: monitor?.configError || null,
      cameras: cameras.map(camera => monitor?.status(camera.id) || { cameraId: camera.id, configured: false, running: false, phase: 'not_configured' }) });
  }));
  router.use('/:id', wrap(async (req, res, next) => {
    if (!UUID.test(req.params.id)) throw badRequest('Choose a valid camera.');
    const camera = checked(await req.db.from('cameras').select('id, is_active').eq('id', req.params.id).single());
    if (!camera?.is_active) throw Object.assign(new Error('Camera not found or inactive.'), { status: 404 });
    if (!monitor) throw Object.assign(new Error('CCTV monitoring is unavailable.'), { status: 503 });
    next();
  }));
  router.get('/:id/frame', (req, res) => {
    const frame = monitor.frame(req.params.id);
    if (!frame) return res.status(503).json({ error: 'No fresh CCTV frame is available. Start the camera and check its connection.' });
    res.set({ 'Cache-Control': 'no-store', 'X-Frame-Received-At': new Date(frame.at).toISOString() }).type('jpeg').send(frame.buffer);
  });
  router.post('/:id/start', requireAdmin, wrap(async (req, res) => {
    if (req.body?.publish !== undefined && typeof req.body.publish !== 'boolean') throw badRequest('Publication mode must be true or false.');
    res.json(await monitor.start(req.params.id, { publish: req.body?.publish === true }));
  }));
  router.post('/:id/stop', requireAdmin, wrap(async (req, res) => res.json(await monitor.stop(req.params.id))));
  return router;
}
module.exports = { cctvRoutes };
