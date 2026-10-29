import React, { useState } from 'react';
import { Car, CircleCheck, CircleHelp, TriangleAlert, Clock3 } from 'lucide-react';
import { age } from '../lib/api';
import { effectiveStatus, statusLabels as labels } from '../lib/parkingStatus';
import { useNow } from '../useNow';
export { effectiveStatus } from '../lib/parkingStatus';
const icons = { vacant: CircleCheck, occupied: Car, blocked: TriangleAlert, unknown: CircleHelp };
export default function CustomerView({ stalls, lot, lots = [], lotId, onLotChange, loading, error, onSetup, embedded = false }) {
  const now = useNow();
  const [zone, setZone] = useState('all');
  const [selected, setSelected] = useState(null);
  const zones = [...new Set(stalls.map(item => item.zone))];
  const counts = stalls.reduce((acc, item) => { const status = effectiveStatus(item, now); acc[status] = (acc[status] || 0) + 1; return acc; }, {});
  const visibleZone = zones.includes(zone) ? zone : 'all';
  const recent = stalls.filter(stall => effectiveStatus(stall, now) !== 'unknown').length;
  const selectedStall = selected && stalls.find(item => item.id === selected);
  return <section className={embedded ? 'availability embedded' : 'page availability'}>
    {!embedded && <div className="page-heading"><div><div className="eyebrow">L U Z A N O · P A R K I N G</div><h1>A clearer view of your parking.</h1><p className="lead">Check the latest observed availability before choosing a space.</p></div>
      <div className="lot-picker">{lots.length > 1 ? <label>Parking area<select value={lotId} onChange={event => onLotChange(event.target.value)}>{lots.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : <span className="location-label">{lot?.name || 'Parking availability'}</span>}</div></div>}
    {error && <div className="notice error" role="alert">Connection interrupted: {error}. Previously observed spaces become unverified when they are stale.</div>}
    <div className="summary-grid">{Object.entries(labels).map(([status, label]) => { const Icon = icons[status]; return <div key={status} className={`summary-cell ${status}`}><div className="summary-label"><Icon size={17} />{label}</div><strong>{counts[status] || 0}</strong><span>{status === 'unknown' ? 'Waiting for a recent observation' : 'Based on a recent frame'}</span></div>; })}</div>
    <div className="section-heading"><div><h2>{lot?.name || 'Parking spaces'}</h2><p className="muted">{stalls.length} active spaces · observations older than 10 seconds are unverified</p></div><span className="refresh-label"><Clock3 size={14} /> Refreshes every 2 seconds</span></div>
    {!loading && stalls.length > 0 && <div className={`coverage-note ${recent ? "" : "waiting"}`}><span className={`dot ${recent ? "good" : ""}`} /><span><strong>{recent} of {stalls.length} spaces verified</strong> · {recent ? "Only recent observations count toward availability." : "Waiting for new published camera observations."}</span></div>}
    <div className="zone-tabs" aria-label="Filter by zone">{['all', ...zones].map(item => <button key={item} aria-pressed={visibleZone === item} className={visibleZone === item ? 'selected' : ''} onClick={() => setZone(item)}>{item === 'all' ? 'All zones' : `Zone ${item}`}</button>)}</div>
    {loading ? <div className="empty-state">Loading parking spaces…</div> : !stalls.length ? <div className="empty-state"><CircleHelp size={30} /><h3>No parking layout found</h3><p>Run the seed SQL or select a parking area with active spaces.</p>{onSetup && <button onClick={onSetup}>View setup</button>}</div> : <div className="parking-layout">{zones.filter(item => visibleZone === 'all' || visibleZone === item).map(item => <div className="zone-block" key={item}><div className="zone-title">ZONE {item}<span /></div><div className="space-grid">{stalls.filter(stall => stall.zone === item).map(stall => {
      const status = effectiveStatus(stall, now), Icon = icons[status] || CircleHelp;
      return <button key={stall.id} className={`parking-space ${status}`} onClick={() => setSelected(stall.id)} aria-label={`Space ${stall.code}: ${labels[status]}`}><Icon size={24} /><strong>{stall.code}</strong><span>{labels[status]}</span></button>;
    })}</div></div>)}</div>}
    <div className="notice subtle">Unverified spaces are not counted as available. Use on-site judgment when the camera has not provided a recent observation.</div>
    {selectedStall && <div className="modal-backdrop" onClick={() => setSelected(null)}><section className="panel modal" role="dialog" aria-modal="true" aria-labelledby="space-title" onClick={event => event.stopPropagation()}><h2 id="space-title">Space {selectedStall.code}</h2><p>Zone {selectedStall.zone} · {labels[effectiveStatus(selectedStall, now)]}</p><p className="muted">Last observation: {age(selectedStall.observed_at)}</p>{selectedStall.observed_at && effectiveStatus(selectedStall, now) === 'unknown' && <p>The last recorded classification was {selectedStall.status}; it is no longer current.</p>}<button className="primary" autoFocus onClick={() => setSelected(null)}>Close</button></section></div>}
  </section>;
}
