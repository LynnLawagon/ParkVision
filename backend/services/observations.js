function checked(response) {
  if (response.error) throw Object.assign(new Error(response.error.message), { status: 502 });
  return response.data;
}
// A stable frame ID makes retries idempotent; observations use one atomic INSERT.
async function writeObservations(db, { frameId, cameraId, capturedAt, accepted, skipped = 0 }) {
  if (!accepted.length) return { saved: 0, skipped, frameId: null, capturedAt };
  const existingFrame = checked(await db.from('camera_frames').select('id').eq('id', frameId).maybeSingle());
  if (!existingFrame) checked(await db.from('camera_frames').insert({ id: frameId, camera_id: cameraId, captured_at: capturedAt }));
  const existing = checked(await db.from('space_observations').select('parking_region_id').eq('camera_frame_id', frameId));
  if (existing.length && existing.length !== accepted.length) throw new Error('This frame has an unexpected partial write. Analyze a fresh frame.');
  if (!existing.length) checked(await db.from('space_observations').insert(accepted.map(item => ({
    parking_region_id: item.regionId, camera_frame_id: frameId, status: item.status, confidence: item.confidence,
  }))));
  return { saved: accepted.length, skipped, frameId, capturedAt };
}
module.exports = { writeObservations, checked };
