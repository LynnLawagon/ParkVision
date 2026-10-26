const express = require('express');
const multer = require('multer');
const { randomUUID } = require('node:crypto');
const { UUID, badRequest, validateRegions, geometryMatches } = require('../validation');
const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

function inferenceRoutes({ worker, authorize, serviceClient, minimumConfidence }) {
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
    let regions;
    try { regions = validateRegions(JSON.parse(req.body.regions || '[]')); }
    catch (error) { throw error.status ? error : badRequest('Invalid parking regions.'); }
    const saved = check(await req.db.from('parking_regions').select('id, x, y, width, height').eq('camera_id', camera.id).eq('is_active', true));
    // Personnel analyze configured regions. Administrators may preview unsaved drafts.
    const matchesSaved = regions.every(region => saved.some(item => geometryMatches(region, item)));
    if (req.profile.role_code !== 'parking_administrator' && !matchesSaved) throw Object.assign(new Error('Only administrators can preview unsaved regions.'), { status: 403 });
    const capturedAt = new Date().toISOString();
    const prediction = await worker.analyze({ image: req.file.buffer.toString('base64'), regions, minimumConfidence });
    for (const [id, analysis] of analyses) if (Date.now() - analysis.createdAt > 600000) analyses.delete(id);
    while (analyses.size >= 50) analyses.delete(analyses.keys().next().value);
    const id = randomUUID();
    analyses.set(id, { owner: req.user.id, cameraId: camera.id, regions, prediction, createdAt: Date.now(), capturedAt, frameId: randomUUID(), published: null, publishing: false });
    res.json({ ...prediction, analysisId: id, capturedAt, savedRegions: matchesSaved, canPublish: Boolean(serviceClient) && matchesSaved });
  }));

  router.post('/publish', wrap(async (req, res) => {
    if (!serviceClient) throw Object.assign(new Error('Add SUPABASE_SERVICE_ROLE_KEY to backend/.env to save observations.'), { status: 503 });
    const analysis = analyses.get(req.body.analysisId);
    if (!analysis || analysis.owner !== req.user.id || Date.now() - analysis.createdAt > 600000) throw badRequest('This preview expired. Analyze the image again.');
    if (analysis.published) return res.json(analysis.published);
    if (analysis.publishing) throw Object.assign(new Error('This analysis is already being saved.'), { status: 409 });
    const saved = check(await req.db.from('parking_regions').select('id, x, y, width, height').eq('camera_id', analysis.cameraId).eq('is_active', true));
    if (!analysis.regions.every(region => saved.some(item => geometryMatches(region, item)))) throw badRequest('Regions changed or are not saved. Save the regions and analyze again.');
    const accepted = analysis.prediction.results.filter(item => !item.requiresReview);
    if (!accepted.length) throw badRequest('All predictions need review. Nothing was published.');
    analysis.publishing = true;
    try {
      // Keep one frame ID for retries. Observation writes below are a single atomic INSERT.
      const existingFrame = check(await serviceClient.from('camera_frames').select('id').eq('id', analysis.frameId).maybeSingle());
      if (!existingFrame) check(await serviceClient.from('camera_frames').insert({ id: analysis.frameId, camera_id: analysis.cameraId, captured_at: analysis.capturedAt }));
      const existing = check(await serviceClient.from('space_observations').select('parking_region_id').eq('camera_frame_id', analysis.frameId));
      if (existing.length && existing.length !== accepted.length) throw new Error('This frame has an unexpected partial write. Analyze the image again.');
      if (!existing.length) check(await serviceClient.from('space_observations').insert(accepted.map(item => ({
        parking_region_id: item.regionId, camera_frame_id: analysis.frameId,
        status: item.status, confidence: item.confidence,
      }))));
      analysis.published = { saved: accepted.length, skipped: analysis.prediction.results.length - accepted.length, frameId: analysis.frameId, capturedAt: analysis.capturedAt };
      res.json(analysis.published);
    } finally { analysis.publishing = false; }
  }));
  return router;
}
module.exports = { inferenceRoutes };
