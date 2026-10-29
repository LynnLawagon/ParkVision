import React, { useEffect, useRef, useState } from 'react';
import { Upload, ScanLine, Save, Play, Square, Plus, Camera, Pencil, Archive, CircleHelp } from 'lucide-react';
import { api, unwrap, age } from '../lib/api';
import CctvPanel from './CctvPanel';
import { createFrameMonitor } from '../lib/frameMonitor';
import { isRecentFrame, statusLabels } from '../lib/parkingStatus';
import { useNow } from '../useNow';

const clamp = number => Math.max(0, Math.min(1, number));
const rounded = number => Number(number.toFixed(6));
const colors = { vacant: '#4FA675', occupied: '#5D7A94', blocked: '#C66A43', review: '#D99C28', waiting: '#C5D3DB' };
export default function RegionsTab({ client, session, isAdmin, lot, spaces, config }) {
  const now = useNow();
  const [cameras, setCameras] = useState([]);
  const [cameraId, setCameraId] = useState('');
  const [allRegions, setAllRegions] = useState([]);
  const [spaceId, setSpaceId] = useState('');
  const [frame, setFrame] = useState(null);
  const [videoSrc, setVideoSrc] = useState('');
  const [live, setLive] = useState(false);
  const [openingCamera, setOpeningCamera] = useState(false);
  const [filename, setFilename] = useState('');
  const [draft, setDraft] = useState(null);
  const [drawing, setDrawing] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [autoPublish, setAutoPublish] = useState(false);
  const [cctvStatus, setCctvStatus] = useState(null);
  const [showCameraForm, setShowCameraForm] = useState(false);
  const [cameraCode, setCameraCode] = useState('');
  const [cameraName, setCameraName] = useState('');
  const video = useRef(null);
  const deviceStream = useRef(null);
  const start = useRef(null);
  const monitor = useRef(null);
  if (!monitor.current) monitor.current = createFrameMonitor();
  const analysisGeneration = useRef(0);
  const busyRef = useRef(false);
  const frameUrl = useRef(null);
  const videoUrl = useRef(null);
  const cameraGeneration = useRef(0);
  const mediaGeneration = useRef(0);
  const cameraRegions = allRegions.filter(region => region.camera_id === cameraId && spaces.some(space => space.id === region.parking_space_id));
  const selectedRegion = cameraRegions.find(region => region.parking_space_id === spaceId);
  const workingRegions = draft ? [...cameraRegions.filter(region => region.parking_space_id !== draft.parking_space_id), draft] : cameraRegions;
  const accepted = analysis?.results.filter(item => !item.requiresReview).length || 0;
  const expired = Boolean(analysis && !isRecentFrame(analysis.capturedAt, now));
  const sourceLabel = live ? 'Live device camera' : videoSrc ? 'Recorded video replay' : frame ? 'Uploaded photo' : 'No source selected';
  const obstructionReady = config.model?.model?.classes?.includes('blocked');

  async function reload() {
    if (!lot) return;
    const [cameraResponse, regionResponse] = await Promise.all([
      client.from('cameras').select('*').eq('parking_lot_id', lot.id).eq('is_active', true).order('code'),
      client.from('parking_regions').select('*').eq('is_active', true),
    ]);
    const nextCameras = unwrap(cameraResponse);
    const nextRegions = unwrap(regionResponse);
    setCameras(nextCameras); setAllRegions(nextRegions);
    const configuredCamera = nextCameras.find(camera => nextRegions.some(region => region.camera_id === camera.id));
    setCameraId(current => nextCameras.some(camera => camera.id === current) ? current : configuredCamera?.id || nextCameras[0]?.id || '');
  }
  function invalidateAnalysis() { analysisGeneration.current += 1; setAnalysis(null); }
  function finishReplay() { setRunning(false); if (!deviceStream.current) video.current?.pause(); }
  function stopReplay() { monitor.current.stop(); finishReplay(); }
  function closeDeviceCamera() {
    stopReplay(); invalidateAnalysis(); mediaGeneration.current += 1;
    deviceStream.current?.getTracks().forEach(track => track.stop());
    deviceStream.current = null; setLive(false); setAutoPublish(false);
  }
  function replaceFrame(blob, width, height) {
    invalidateAnalysis();
    if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
    const url = URL.createObjectURL(blob);
    frameUrl.current = url;
    const next = { blob, url, width, height };
    setFrame(next);
    return next;
  }
  useEffect(() => { reload().catch(error => setError(error.message)); }, [client, lot?.id]);
  useEffect(() => {
    closeDeviceCamera(); cameraGeneration.current += 1; mediaGeneration.current += 1;
    setSpaceId(''); setDraft(null); setDrawing(false); invalidateAnalysis(); setMessage(''); setError('');
    setFrame(null); setVideoSrc(''); setFilename('');
    if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
    if (videoUrl.current) URL.revokeObjectURL(videoUrl.current);
    frameUrl.current = null; videoUrl.current = null;
  }, [cameraId]);
  useEffect(() => () => {
    monitor.current.stop(); analysisGeneration.current += 1;
    cameraGeneration.current += 1; mediaGeneration.current += 1;
    deviceStream.current?.getTracks().forEach(track => track.stop());
    if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
    if (videoUrl.current) URL.revokeObjectURL(videoUrl.current);
  }, []);
  useEffect(() => {
    if (live && video.current && deviceStream.current) {
      video.current.srcObject = deviceStream.current;
      video.current.play().catch(error => setError(error.message));
    }
  }, [live]);
  useEffect(() => {
    if (!cctvStatus?.running) return;
    closeDeviceCamera(); setVideoSrc(''); setFrame(null); invalidateAnalysis(); setDraft(null); setDrawing(false);
    setFilename('');
  }, [cctvStatus?.running, cameraId]);

  async function openDeviceCamera() {
    if (openingCamera) return;
    setError(''); setMessage('');
    if (!navigator.mediaDevices?.getUserMedia) { setError('Device camera access needs localhost or HTTPS. Use a photo/video until the app is hosted securely.'); return; }
    const generation = cameraGeneration.current;
    setOpeningCamera(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      if (generation !== cameraGeneration.current) { stream.getTracks().forEach(track => track.stop()); return; }
      stopReplay(); invalidateAnalysis(); mediaGeneration.current += 1;
      deviceStream.current?.getTracks().forEach(track => track.stop());
      deviceStream.current = stream; setVideoSrc(''); setFrame(null); invalidateAnalysis(); setDraft(null); setAutoPublish(false);
      setFilename('Live device camera'); setLive(true);
    } catch (error) { setError(error.name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access in your browser or upload a frame.' : `Could not open the device camera: ${error.message}`); }
    finally { setOpeningCamera(false); }
  }

  async function captureVideoFrame() {
    const element = video.current;
    const generation = mediaGeneration.current;
    if (!element || element.readyState < 2) throw new Error('Wait for the video frame to load.');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 2560 / Math.max(element.videoWidth, element.videoHeight));
    canvas.width = Math.round(element.videoWidth * scale); canvas.height = Math.round(element.videoHeight * scale);
    canvas.getContext('2d').drawImage(element, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    if (!blob) throw new Error('Could not read this video frame. Try an MP4 video.');
    if (generation !== mediaGeneration.current || element !== video.current) throw new Error('The selected camera or media changed. Choose a new reference frame.');
    return replaceFrame(blob, canvas.width, canvas.height);
  }
  async function uploadFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const generation = ++mediaGeneration.current;
    stopReplay(); deviceStream.current?.getTracks().forEach(track => track.stop()); deviceStream.current = null; setLive(false); setAutoPublish(false);
    setError(''); setMessage(''); invalidateAnalysis(); setDraft(null); setDrawing(false); setFilename(file.name);
    if (videoUrl.current) URL.revokeObjectURL(videoUrl.current);
    setVideoSrc(''); setFrame(null);
    try {
      if (file.type.startsWith('video/')) {
        const url = URL.createObjectURL(file); videoUrl.current = url; setVideoSrc(url);
      } else {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG, WebP, or a supported MP4/MOV video.');
        if (file.size > 8 * 1024 * 1024) throw new Error('Image must be smaller than 8 MB.');
        const url = URL.createObjectURL(file);
        const image = new Image(); image.src = url;
        try { await image.decode(); if (generation === mediaGeneration.current) replaceFrame(file, image.naturalWidth, image.naturalHeight); }
        finally { URL.revokeObjectURL(url); }
      }
    } catch (error) { setError(error.message); }
  }
  function chooseSpace(id) { setSpaceId(id); if (draft) invalidateAnalysis(); setDraft(null); setDrawing(false); setMessage(''); }
  function point(event) {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) };
  }
  function move(event) {
    if (!start.current) return;
    const end = point(event);
    const x = rounded(Math.min(start.current.x, end.x)), y = rounded(Math.min(start.current.y, end.y));
    const right = rounded(Math.max(start.current.x, end.x)), bottom = rounded(Math.max(start.current.y, end.y));
    setDraft({ id: selectedRegion?.id || start.current.id, parking_space_id: spaceId, camera_id: cameraId,
      x, y, width: rounded(right - x), height: rounded(bottom - y) });
  }
  function pointerDown(event) {
    if (!drawing || !isAdmin || !spaceId || busy || running) return;
    event.preventDefault(); video.current?.pause(); invalidateAnalysis();
    start.current = { ...point(event), id: crypto.randomUUID() };
    event.currentTarget.setPointerCapture(event.pointerId);
    invalidateAnalysis();
  }
  function pointerUp(event) {
    if (!start.current) return;
    move(event); start.current = null; setDrawing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  async function saveRegion() {
    if (!draft || draft.width < 0.01 || draft.height < 0.01) { setError('Draw a box at least 1% of the image in each direction.'); return; }
    setSaving(true); setError(''); setMessage('');
    try {
      const existing = allRegions.find(region => region.parking_space_id === draft.parking_space_id);
      if (existing && existing.camera_id !== cameraId) throw new Error('This space is configured on another camera. Archive its old region first.');
      const dimensions = { x: draft.x, y: draft.y, width: draft.width, height: draft.height };
      if (existing) unwrap(await client.from('parking_regions').update(dimensions).eq('id', existing.id).select().single());
      else unwrap(await client.from('parking_regions').insert({ ...dimensions, camera_id: cameraId, parking_space_id: draft.parking_space_id }).select().single());
      await reload(); setDraft(null); invalidateAnalysis(); setMessage('Region saved to Supabase. You can now analyze this space.');
    } catch (error) { setError(error.message); }
    finally { setSaving(false); }
  }
  async function archiveRegion(region) {
    setSaving(true); setError(''); setMessage('');
    try {
      unwrap(await client.from('parking_regions').update({ is_active: false }).eq('id', region.id).select().single());
      await reload(); invalidateAnalysis(); setDraft(null); setMessage('Region archived. Its detection history is preserved.');
    } catch (error) { setError(error.message); }
    finally { setSaving(false); }
  }
  async function addCamera(event) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const camera = unwrap(await client.from('cameras').insert({ parking_lot_id: lot.id, code: cameraCode.trim(), name: cameraName.trim() }).select().single());
      await reload(); setCameraId(camera.id); setShowCameraForm(false); setCameraCode(''); setCameraName('');
    } catch (error) { setError(error.message); }
    finally { setSaving(false); }
  }
  async function runAnalysis(nextFrame = frame) {
    if (!nextFrame || !workingRegions.length || busyRef.current) return null;
    const generation = analysisGeneration.current;
    busyRef.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const form = new FormData(); form.append('image', nextFrame.blob, 'frame.jpg');
      form.append('cameraId', cameraId); form.append('regions', JSON.stringify(workingRegions));
      const result = await api('/inference/analyze', { method: 'POST', token: session.access_token, body: form });
      if (generation !== analysisGeneration.current) return null;
      setAnalysis(result);
      return result;
    } catch (error) { if (generation !== analysisGeneration.current) return null; setError(error.message); throw error; }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function publish(result = analysis, quiet = false) {
    if (!result) return;
    if (!isRecentFrame(result.capturedAt)) { setError('This preview has expired. Analyze a fresh frame before publishing.'); return; }
    if (!quiet) setSaving(true);
    try {
      const saved = await api('/inference/publish', { method: 'POST', token: session.access_token, body: { analysisId: result.analysisId } });
      setMessage(`Saved ${saved.saved} observation${saved.saved === 1 ? '' : 's'}. ${saved.skipped} skipped for review.`);
      setAnalysis(current => current?.analysisId === result.analysisId ? { ...current, published: saved } : current);
      // Public polling already refreshes every 2 seconds; do not remount the workspace.
      return saved;
    } catch (error) { setError(error.message); throw error; }
    finally { if (!quiet) setSaving(false); }
  }
  async function startReplay() {
    if (!video.current || !cameraRegions.length || draft || monitor.current.running) return;
    setError(''); setMessage(''); setRunning(true);
    await monitor.current.start({
      prepare: async () => {
        const element = video.current;
        if (element.ended) element.currentTime = 0;
        await element.play();
      },
      shouldContinue: () => Boolean(video.current && !video.current.ended && !video.current.paused),
      capture: captureVideoFrame,
      analyze: runAnalysis,
      publish: autoPublish ? result => publish(result, true) : undefined,
      onError: error => setError(error.message),
      onStop: finishReplay,
    });
  }
  const disabled = busy || saving || running || openingCamera;
  const mediaDisabled = disabled || cctvStatus?.running;
  function useCctvFrame(blob, width, height) {
    closeDeviceCamera(); mediaGeneration.current++;
    if (videoUrl.current) URL.revokeObjectURL(videoUrl.current);
    videoUrl.current = null; setVideoSrc(''); invalidateAnalysis(); setDraft(null);
    setFilename(cctvStatus?.kind === 'demo_replay' ? 'CCTV demo replay reference' : 'CCTV reference frame');
    replaceFrame(blob, width, height);
  }
  return <div className="camera-workspace">
    <div className="workspace-intro"><div><h2>Monitor your parking spaces</h2><p className="muted">Choose a view, check its saved boxes, then analyze and publish.</p></div><details className="model-details"><summary><span className={config.model?.state === 'ready' ? 'dot good' : 'dot'} /> Model {config.model?.state || 'unavailable'}</summary><p>{obstructionReady ? 'Detects vacant, vehicle-occupied, and non-vehicle-blocked positions.' : 'Detects vehicle presence. Obstruction classification is unavailable in this model.'}</p><p>Scores below {Math.round(config.minimumConfidence * 100)}% need review and stay unpublished.</p>{config.model?.model && <code>{config.model.model.name} · {config.model.model.version}</code>}</details></div>
    {!lot ? <div className="empty-state">Select a parking area with a saved layout.</div> : <>
      <div className="camera-toolbar"><label>Camera<select value={cameraId} disabled={disabled} onChange={event => setCameraId(event.target.value)}><option value="" disabled>Choose a camera</option>{cameras.map(camera => <option value={camera.id} key={camera.id}>{camera.code} · {camera.name}</option>)}</select></label>
        {isAdmin && <button disabled={disabled} onClick={() => setShowCameraForm(value => !value)}><Plus size={16} />Add camera</button>}

      </div>
      {showCameraForm && <form className="panel inline-form" onSubmit={addCamera}><label>Camera code<input required maxLength={40} placeholder="PHONE-01" value={cameraCode} onChange={event => setCameraCode(event.target.value)} /></label><label>Name<input required maxLength={160} placeholder="Mounted phone · front area" value={cameraName} onChange={event => setCameraName(event.target.value)} /></label><button className="primary" disabled={saving}>Create camera</button></form>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {message && <div className="notice success" role="status">{message}</div>}
      {config.model?.error && <div className="notice error">{config.model.error}</div>}
      {!config.cctvEnabled && <section className="panel cctv-placeholder" aria-labelledby="cctv-placeholder-title"><div className="cctv-placeholder-icon"><Camera size={22} aria-hidden="true" /></div><div><h3 id="cctv-placeholder-title">CCTV connection <span className="badge">Future development</span></h3><p>Parking models work with photos, videos, and device cameras. Live CCTV connection is planned.</p></div><button disabled title="CCTV connection is planned for a future update">Connect CCTV</button></section>}
      {config.cctvEnabled && cameraId && <CctvPanel key={cameraId} cameraId={cameraId} session={session} isAdmin={isAdmin} disabled={disabled || Boolean(draft)} regions={cameraRegions} spaces={spaces} onStatus={setCctvStatus} onUseFrame={useCctvFrame} />}
      <div className="source-status" role="status"><span className={`badge ${live ? 'good' : ''}`}>{sourceLabel}</span><span>{running ? autoPublish ? 'Monitoring · accepted results publish automatically' : 'Monitoring · preview only' : frame ? (videoSrc || live ? 'Monitoring stopped · analyze to preview a frame' : 'Single frame · analyze to preview, then publish') : 'Upload a photo/video or open the device camera to begin.'}</span></div>
      <div className="editor-grid"><section className="panel frame-panel">
        <div className="section-heading"><div><h2>1. Choose a reference frame</h2><p className="muted">Use the same mounted position, orientation, and zoom for this camera.</p></div><div className="button-row"><label className={`button upload-button ${!cameraId || mediaDisabled ? 'disabled' : ''}`}><Upload size={16} />Upload photo / video<input key={cameraId} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" disabled={!cameraId || mediaDisabled} onChange={uploadFile} /></label>{!live && <button disabled={!cameraId || mediaDisabled} onClick={openDeviceCamera}><Camera size={16} />Use device camera</button>}</div></div>
        {cctvStatus?.running && <p className="notice subtle">This camera is monitored by the backend. Use its CCTV reference frame to configure boxes. Stop CCTV monitoring before switching to uploaded media or a device camera.</p>}
        {filename && <p className="file-label">{filename} {frame && `· ${frame.width} × ${frame.height}`}</p>}
        {(videoSrc || live) && <div className="video-tools"><video ref={video} src={live ? undefined : videoSrc} controls={!live} autoPlay={live} muted playsInline onLoadedData={() => captureVideoFrame().catch(error => setError(error.message))} onPause={() => { if (monitor.current.running) stopReplay(); }} onEnded={stopReplay} onError={() => setError('This browser cannot decode the video. Export it as MP4 (H.264), or upload a photo.')} /><button disabled={disabled} onClick={() => { if (!live) video.current.pause(); captureVideoFrame().then(() => setAnalysis(null)).catch(error => setError(error.message)); }}>{live ? 'Grab camera frame' : 'Use current video frame'}</button>{live && <button onClick={closeDeviceCamera}>Close device camera</button>}</div>}
        {frame ? <div className={`frame-canvas ${drawing ? 'drawing' : ''}`}>
          <img src={frame.url} alt="Reference camera frame for parking regions" draggable={false} />
          <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" role="img" aria-label="Parking region drawing canvas" onPointerDown={pointerDown} onPointerMove={move} onPointerUp={pointerUp} onPointerCancel={() => { start.current = null; setDrawing(false); }}>
            {workingRegions.map(region => {
              const result = analysis?.results.find(item => item.regionId === region.id);
              const space = spaces.find(item => item.id === region.parking_space_id);
              const color = result ? colors[result.requiresReview ? 'review' : result.status] : colors.waiting;
              const label = `${space?.code || 'Space'}${result ? ` · ${result.status} ${Math.round(result.confidence * 100)}%${result.requiresReview ? ' · needs review' : ''}` : ''}`;
              return <g key={region.id} onPointerDown={event => { if (!drawing) { event.stopPropagation(); if (!disabled) chooseSpace(region.parking_space_id); } }}>
                <rect x={region.x * 1000} y={region.y * 1000} width={region.width * 1000} height={region.height * 1000} fill={color} fillOpacity={0.10} stroke={color} strokeWidth={spaceId === region.parking_space_id ? 5 : 3} vectorEffect="non-scaling-stroke" strokeDasharray={draft?.id === region.id ? '8 5' : undefined} />
                <rect x={region.x * 1000} y={region.y * 1000} width={Math.min(label.length * 10 + 16, 1000 - region.x * 1000)} height={32} fill={color} />
                <text x={region.x * 1000 + 8} y={region.y * 1000 + 23} fill="#17222a" fontSize={22} fontWeight="700">{label}</text>
              </g>;
            })}
          </svg>
        </div> : <div className="frame-placeholder"><Camera size={42} /><h3>Your camera view goes here</h3><p>Upload a photo or choose a frame from a video.<br />Saved boxes will line up with that fixed camera view.</p></div>}
        {drawing && <p className="notice">Drag across the image to draw the selected parking space.</p>}
        <p className="small muted">The uploaded frame stays in this workspace. Images are processed in memory; this version saves observations, not the photo or video file.</p>
      </section>
      <aside className="panel region-panel"><h2>2. Define virtual spaces</h2><p className="muted">{cameraRegions.length} configured on this camera · {spaces.length} total spaces in the area</p>
        <p className="small muted">Frame one parking position with minimal unrelated background. Include the vehicle when occupied, but leave out the building ceiling. Keep the same box when the vehicle leaves.</p>
        {isAdmin ? <><label>Parking space<select value={spaceId} disabled={disabled} onChange={event => chooseSpace(event.target.value)}><option value="">Select a space</option>{spaces.map(space => {
          const other = allRegions.find(region => region.parking_space_id === space.id && region.camera_id !== cameraId);
          return <option value={space.id} key={space.id} disabled={Boolean(other)}>{space.code}{other ? ' · configured on another camera' : ''}</option>;
        })}</select></label>
        <button className="full" disabled={!spaceId || !frame || disabled} onClick={() => { setDrawing(true); invalidateAnalysis(); }}><Pencil size={16} />{selectedRegion ? 'Redraw this box' : 'Draw parking box'}</button>
        {draft && <div className="draft-actions"><p className="badge warning">Unsaved region</p><button className="primary full" disabled={disabled} onClick={saveRegion}><Save size={16} />Save region</button><button className="quiet full" disabled={disabled} onClick={() => { setDraft(null); invalidateAnalysis(); }}>Discard changes</button></div>}
        </> : <p className="notice">An administrator can add or adjust parking regions. You can analyze the saved regions.</p>}
        <div className="region-list">{cameraRegions.map(region => <div key={region.id} className={`region-list-row ${spaceId === region.parking_space_id ? 'active' : ''}`}><button className="region-select" disabled={disabled} onClick={() => chooseSpace(region.parking_space_id)}><strong>{spaces.find(space => space.id === region.parking_space_id)?.code}</strong><span>Saved region</span></button>{isAdmin && <button className="icon-button" disabled={disabled} aria-label={`Archive region ${spaces.find(space => space.id === region.parking_space_id)?.code}`} onClick={() => archiveRegion(region)}><Archive size={15} /></button>}</div>)}</div>
        {!cameraRegions.length && <p className="muted small">No saved boxes yet. Choose a space, draw its full parking area, and save it.</p>}
        <div className="small calibration-note"><CircleHelp size={16} />Save boxes once for this fixed view. Redraw them only if the camera position, zoom, or intended parking area changes.</div>
      </aside></div>
      <section className="panel analysis-panel"><div className="section-heading"><div><h2>3. Analyze and publish</h2><p className="muted">Analyze to preview. Publish accepted results to update availability and alerts.</p></div><div className="button-row">
        <button className="primary" disabled={!frame || !workingRegions.length || mediaDisabled || config.model?.state !== 'ready'} onClick={() => runAnalysis().catch(() => {})}><ScanLine size={17} />{busy ? 'Analyzing…' : 'Analyze this frame'}</button>
        <button disabled={!analysis?.canPublish || !accepted || expired || mediaDisabled || Boolean(analysis.published)} onClick={() => publish().catch(() => {})}><Save size={16} />{analysis?.published ? 'Published' : expired ? 'Analyze again to publish' : `Publish ${accepted || ''} accepted result${accepted === 1 ? '' : 's'}`}</button>
      </div></div>
      {!config.writeEnabled && <p className="notice warning">{config.publicationError || 'Model previews work after sign-in. Add the server-only Supabase key in backend/.env to publish results.'}</p>}
      {analysis && <><div className="analysis-meta"><span className={`badge ${analysis.published ? 'good' : expired ? 'warning' : ''}`}>{analysis.published ? 'Published' : expired ? 'Preview expired' : 'Preview · not published'}</span><span>Analyzed {age(analysis.capturedAt)}</span><span>{analysis.results.length - accepted} need review</span></div>
        {expired && <p className="notice warning">This preview is older than 10 seconds. {analysis.published ? 'Its observations are now unverified; keep monitoring to maintain current availability.' : 'Analyze a fresh frame before publishing.'}</p>}
        {!analysis.savedRegions && <p className="notice warning">This preview includes unsaved boxes. Save the regions and analyze again before publishing.</p>}
        <div className="table-scroll"><table><thead><tr><th>Space</th><th>Prediction</th><th>Class score</th><th>Action</th></tr></thead><tbody>{analysis.results.map(result => <tr key={result.regionId}><td><strong>{spaces.find(space => space.id === workingRegions.find(region => region.id === result.regionId)?.parking_space_id)?.code || result.regionId.slice(0, 8)}</strong></td><td><span className={`badge ${result.requiresReview || result.status === 'blocked' ? 'warning' : result.status === 'vacant' ? 'good' : ''}`}>{statusLabels[result.status] || result.status}</span></td><td>{(result.confidence * 100).toFixed(1)}%</td><td>{result.requiresReview ? 'Needs review · not published' : analysis.published ? expired ? 'Saved · now unverified' : 'Published' : expired ? 'Analyze again' : 'Ready to publish'}</td></tr>)}</tbody></table></div>
        <details className="prediction-details"><summary>Model scores and timing</summary><p className="small muted">{analysis.model.name} · {analysis.model.version} · {analysis.inferenceMs} ms inference</p><div className="table-scroll"><table><thead><tr><th>Space</th><th>Vehicle score</th>{obstructionReady && <th>Obstruction score</th>}</tr></thead><tbody>{analysis.results.map(result => <tr key={result.regionId}><td>{spaces.find(space => space.id === workingRegions.find(region => region.id === result.regionId)?.parking_space_id)?.code || result.regionId.slice(0, 8)}</td><td>{(result.occupancyScore * 100).toFixed(1)}%</td>{obstructionReady && <td>{((result.obstructionScore || 0) * 100).toFixed(1)}%</td>}</tr>)}</tbody></table></div></details>
        <p className="small muted">Scores describe the model output, not verified accuracy. Unknown and review results never become available spaces automatically. An uploaded image is a point-in-time observation; it becomes stale after 10 seconds.</p>
      </>}
      {!analysis && <p className="analysis-empty muted">{!frame ? "Choose a reference frame to begin." : !workingRegions.length ? "Save a parking box before analyzing." : "Your predictions will appear here. Analyzing alone does not update availability."}</p>}
      {(videoSrc || live) && <div className="replay-controls"><div><h3>{live ? 'Live device-camera monitoring' : 'Recorded-video monitoring'}</h3><p className="muted small">{live ? 'Keep the phone fixed. Capture and analyze a new frame about every 2 seconds.' : 'Analyze the playing clip about every 2 seconds. This is video replay, not a live camera connection.'}</p><p className="small muted">Keep this workspace open while monitoring. <a href="/" target="_blank" rel="noopener noreferrer">Open availability in another tab</a>.</p><label className="checkbox"><input type="checkbox" checked={autoPublish} disabled={running || !config.writeEnabled} onChange={event => setAutoPublish(event.target.checked)} />{live ? 'Publish accepted camera observations to the dashboard' : 'Publish accepted replay observations to the dashboard'}</label></div>{running ? <button onClick={stopReplay}><Square size={15} />{live ? 'Stop monitoring' : 'Stop replay'}</button> : <button disabled={!frame || !cameraRegions.length || Boolean(draft) || busy || saving || config.model?.state !== 'ready'} onClick={startReplay}><Play size={15} />{live ? 'Start camera monitoring' : 'Analyze video replay'}</button>}</div>}
      </section>
    </>}
  </div>;
}
