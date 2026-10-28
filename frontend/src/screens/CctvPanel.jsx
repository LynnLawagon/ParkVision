import React, { useEffect, useRef, useState } from 'react';
import { Camera, Play, Square } from 'lucide-react';
import { api, age } from '../lib/api';

export default function CctvPanel({ cameraId, session, isAdmin, disabled, regions, spaces, onUseFrame, onStatus }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [publish, setPublish] = useState(false);
  const [preview, setPreview] = useState(null);
  const previewRef = useRef(null);
  const token = session.access_token;
  useEffect(() => {
    let cancelled = false, timer;
    const controller = new AbortController();
    let lastSequence = null;
    setStatus(null); setPreview(null); setError(''); onStatus(null);
    if (previewRef.current) URL.revokeObjectURL(previewRef.current.url);
    previewRef.current = null;
    async function poll() {
      try {
        const result = await api('/cctv', { token });
        if (cancelled) return;
        const next = result.cameras.find(camera => camera.cameraId === cameraId) || null;
        setStatus(next); onStatus(next); setError(result.error || '');
        if (next?.connected && next.frameSequence !== lastSequence) {
          const response = await fetch(`/api/cctv/${cameraId}/frame`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
          if (response.ok) {
            const blob = await response.blob();
            if (cancelled) return;
            const url = URL.createObjectURL(blob);
            if (previewRef.current) URL.revokeObjectURL(previewRef.current.url);
            previewRef.current = { blob, url };
            setPreview(previewRef.current); lastSequence = next.frameSequence;
          }
        } else if (!next?.connected) {
          if (previewRef.current) URL.revokeObjectURL(previewRef.current.url);
          previewRef.current = null; setPreview(null); lastSequence = null;
        }
      } catch (error) { if (!cancelled) setError(error.message); }
      finally { if (!cancelled) timer = setTimeout(poll, 2000); }
    }
    if (cameraId) poll();
    return () => {
      cancelled = true; clearTimeout(timer); controller.abort();
      if (previewRef.current) URL.revokeObjectURL(previewRef.current.url);
      previewRef.current = null;
    };
  }, [cameraId, token]);

  async function control(action) {
    setBusy(true); setError('');
    try {
      const next = await api(`/cctv/${cameraId}/${action}`, { token, method: 'POST', body: { publish } });
      setStatus(next); onStatus(next);
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  async function useFrame() {
    if (!preview) return;
    setBusy(true); setError('');
    const image = new Image(); image.src = preview.url;
    try { await image.decode(); onUseFrame(preview.blob, image.naturalWidth, image.naturalHeight); }
    catch { setError('Could not read the CCTV reference frame. Try again with a fresh frame.'); }
    finally { setBusy(false); }
  }
  const replay = status?.kind === 'demo_replay';
  return <section className="panel cctv-panel">
    <div className="section-heading"><div><h2><Camera size={18} /> CCTV monitoring {replay && <span className="badge warning">Demo replay</span>}</h2>
      <p className="muted">{status?.configured ? 'The backend reads this source and monitors saved boxes, including when this workspace is closed.' : 'No CCTV stream is connected to this camera yet. Camera names and parking boxes can be prepared before the recorder is available.'}</p></div>
      <span className={`badge ${status?.connected ? 'good' : ''}`}>{status?.phase?.replaceAll('_', ' ') || 'Checking connection…'}</span>
    </div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {status?.configured ? <>
      {preview && <img className="cctv-preview" src={preview.url} alt={replay ? 'Recorded demo source preview' : 'Latest CCTV camera frame'} />}
      <div className="button-row">
        {isAdmin && <>{status.running ? <button disabled={busy} onClick={() => control('stop')}><Square size={15} />Stop CCTV monitoring</button> : <button className="primary" disabled={disabled || busy} onClick={() => control('start')}><Play size={15} />Start CCTV monitoring</button>}
          <label className="checkbox"><input type="checkbox" checked={status.running ? status.publishing : publish} disabled={status.running || busy} onChange={event => setPublish(event.target.checked)} />{replay ? 'Publish replay observations (demo)' : 'Publish accepted CCTV observations'}</label></>}
        <button disabled={!preview || disabled || busy} onClick={useFrame}>Use CCTV frame for parking boxes</button>
      </div>
      <p className="small muted">{status.running ? `Publishing ${status.publishing ? 'enabled' : 'off — preview only'}.` : 'Monitoring stopped.'} {status.analyzedFrames || 0} frames analyzed · {status.savedObservations || 0} observations saved. {replay ? 'Replay uses analysis-time timestamps and is not live site footage.' : 'Frames are sampled; this preview is not full-motion video.'}</p>
      {status.error && <p className="notice warning">{status.error}</p>}
      {status.lastAnalysis && <><p className="small muted">Latest classification: {age(status.lastAnalysis.capturedAt)} · {status.lastAnalysis.model?.name}</p>
        <div className="table-scroll"><table><thead><tr><th>Space</th><th>Prediction</th><th>Class score</th><th>Review</th></tr></thead><tbody>{status.lastAnalysis.results.map(result => <tr key={result.regionId}>
          <td>{spaces.find(space => space.id === regions.find(region => region.id === result.regionId)?.parking_space_id)?.code || result.regionId.slice(0, 8)}</td>
          <td>{result.status}</td><td>{(result.confidence * 100).toFixed(1)}%</td><td>{result.requiresReview ? 'Needs review' : 'Accepted'}</td>
        </tr>)}</tbody></table></div></>}
    </> : isAdmin && <p className="small muted">Camera ID: <code>{cameraId}</code>. Connect its stream using the server setup in <code>docs/cctv.md</code>. No database reset is needed.</p>}
  </section>;
}
