const express = require('express');
const multer = require('multer');
const { randomUUID } = require('node:crypto');
const { UUID, badRequest, validateRegions, geometryMatches } = require('../validation');
const { writeObservations } = require('../services/observations');
const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

function inferenceRoutes({ worker, authorize, serviceClient, minimumConfidence, monitor, clock = Date.now }) {
  const router = express.Router();
  const analyses = new Map();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 4, fieldSize: 65536 } });
  const check = response => { if (response.error) throw Object.assign(new Error(response.error.message), { status: 502 }); return response.data; };
  router.use(authorize);
  router.post('/analyze', upload.single('image'), wrap(async (req, res) => {
    if (!req.file) throw badRequest('Upload a JPEG, PNG, or WebP frame.');
    if (!UUID.test(req.body.cameraId || '')) throw badRequest('Choose a camera.');
    const camera = check(await req.db.from('cameras').select('id, is_active').eq('id', req.body.cameraId).single());
    if (!camera?.is_active) throw badRequest('This camera is inactive.');
    if (monitor?.status(camera.id).running) throw Object.assign(new Error('Stop CCTV monitoring for this camera before analyzing uploaded media or a device-camera frame.'), { status: 409 });
    let regions;
    try { regions = validateRegions(JSON.parse(req.body.regions || '[]')); }
    catch (error) { throw error.status ? error : badRequest('Invalid parking regions.'); }
    const saved = check(await req.db.from('parking_regions').select('id, x, y, width, height').eq('camera_id', camera.id).eq('is_active', true));
    // Personnel analyze configured regions. Administrators may preview unsaved drafts.
    const matchesSaved = regions.every(region => saved.some(item => geometryMatches(region, item)));
    if (req.profile.role_code !== 'parking_administrator' && !matchesSaved) throw Object.assign(new Error('Only administrators can preview unsaved regions.'), { status: 403 });
    const capturedAt = new Date(clock()).toISOString();
    const prediction = await worker.analyze({ image: req.file.buffer.toString('base64'), regions, minimumConfidence });
    for (const [id, analysis] of analyses) if (clock() - analysis.createdAt > 600000) analyses.delete(id);
    while (analyses.size >= 50) analyses.delete(analyses.keys().next().value);
    const id = randomUUID();
    analyses.set(id, { owner: req.user.id, cameraId: camera.id, regions, prediction, createdAt: clock(), capturedAt, frameId: randomUUID(), published: null, publishing: false });
    res.json({ ...prediction, analysisId: id, capturedAt, savedRegions: matchesSaved, canPublish: Boolean(serviceClient) && matchesSaved });
  }));

  router.post('/publish', wrap(async (req, res) => {
    if (!serviceClient) throw Object.assign(new Error('Add SUPABASE_SERVICE_ROLE_KEY to backend/.env to save observations.'), { status: 503 });
    const analysis = analyses.get(req.body.analysisId);
    if (!analysis || analysis.owner !== req.user.id || clock() - analysis.createdAt > 600000) throw badRequest('This preview expired. Analyze the image again.');
    if (monitor?.status(analysis.cameraId).running) throw Object.assign(new Error('This camera is now monitored by the backend. Stop CCTV monitoring before publishing a manual preview.'), { status: 409 });
    if (analysis.published) return res.json(analysis.published);
    if (clock() - Date.parse(analysis.capturedAt) >= 10000) throw badRequest('This frame is older than 10 seconds. Analyze a fresh frame before publishing.');
    if (analysis.publishing) throw Object.assign(new Error('This analysis is already being saved.'), { status: 409 });
    const camera = check(await req.db.from('cameras').select('id, is_active').eq('id', analysis.cameraId).single());
    if (!camera?.is_active) throw badRequest('This camera is inactive. Choose an active camera and analyze again.');
    const saved = check(await req.db.from('parking_regions').select('id, x, y, width, height').eq('camera_id', analysis.cameraId).eq('is_active', true));
    if (!analysis.regions.every(region => saved.some(item => geometryMatches(region, item)))) throw badRequest('Regions changed or are not saved. Save the regions and analyze again.');
    // Database round-trips may have taken this frame beyond its useful age.
    if (clock() - Date.parse(analysis.capturedAt) >= 10000) throw badRequest('This frame is older than 10 seconds. Analyze a fresh frame before publishing.');
    const accepted = analysis.prediction.results.filter(item => !item.requiresReview);
    if (!accepted.length) throw badRequest('All predictions need review. Nothing was published.');
    analysis.publishing = true;
    try {
      analysis.published = await writeObservations(serviceClient, { frameId: analysis.frameId,
        cameraId: analysis.cameraId, capturedAt: analysis.capturedAt, accepted,
        skipped: analysis.prediction.results.length - accepted.length });
      res.json(analysis.published);
    } finally { analysis.publishing = false; }
  }));
  return router;
}
module.exports = { inferenceRoutes };
