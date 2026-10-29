import React, { useEffect, useRef, useState } from 'react';
import { LayoutGrid, ScanLine, Bell, History } from 'lucide-react';
import CustomerView, { effectiveStatus } from './CustomerView';
import RegionsTab from './RegionsTab';
import { age, roleNames, unwrap } from '../lib/api';
import { useNow } from '../useNow';
export default function AdminView({ client, session, profile, lot, lots, lotId, onLotChange, stalls, config, onRefresh, parkingError }) {
  const now = useNow();
  const [tab, setTab] = useState('workspace');
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const isAdmin = profile.role_code === 'parking_administrator';
  const spacesRef = useRef(stalls);
  spacesRef.current = stalls;
  const blocked = stalls.filter(space => effectiveStatus(space, now) === 'blocked');
  useEffect(() => {
    if (!['alerts', 'audit'].includes(tab)) return;
    let active = true, timer;
    setItems([]); setError('');
    async function load() {
      try {
        if (tab === 'audit') {
          const data = unwrap(await client.from('region_change_log').select('*').order('changed_at', { ascending: false }).limit(100));
          if (active) setItems(data);
        } else {
          const data = unwrap(await client.from('obstruction_alerts').select('*, alert_acknowledgements(*)').is('resolution_observation_id', null));
          const ids = data.map(item => item.opening_observation_id);
          const observations = ids.length ? unwrap(await client.from('space_observations').select('id, parking_region_id, processed_at').in('id', ids)) : [];
          const regionIds = observations.map(item => item.parking_region_id);
          const regions = regionIds.length ? unwrap(await client.from('parking_regions').select('id, parking_space_id').in('id', regionIds)) : [];
          const result = data.map(item => {
            const observation = observations.find(o => o.id === item.opening_observation_id);
            const region = regions.find(r => r.id === observation?.parking_region_id);
            return { ...item, openedAt: observation?.processed_at, space: spacesRef.current.find(s => s.id === region?.parking_space_id) };
          }).filter(item => item.space);
          if (active) setItems(result);
        }
        if (active) setError('');
      } catch (error) { if (active) setError(error.message); }
      finally { if (active && tab === 'alerts') timer = setTimeout(load, 2000); }
    }
    load();
    return () => { active = false; clearTimeout(timer); };
  }, [tab, refresh, client, lotId]);
  async function acknowledge(id) {
    try { unwrap(await client.rpc('acknowledge_alert', { p_alert_id: id })); setRefresh(n => n + 1); }
    catch (error) { setError(error.message); }
  }
  const tabs = [{ id: 'workspace', label: 'Camera workspace', icon: ScanLine }, { id: 'overview', label: 'Availability', icon: LayoutGrid }, { id: 'alerts', label: 'Alerts', icon: Bell }, ...(isAdmin ? [{ id: 'audit', label: 'Region history', icon: History }] : [])];
  return <main className="page personnel-page"><div className="page-heading"><div><div className="eyebrow">PERSONNEL WORKSPACE</div><h1>Parking workspace</h1><p className="muted">{profile.display_name || session.user.email}{profile.display_name !== roleNames[profile.role_code] && ` · ${roleNames[profile.role_code]}`}</p></div>
    <label className="lot-picker">Parking area<select value={lotId} onChange={event => onLotChange(event.target.value)}>{lots.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
    {blocked.length > 0 && <div className="notice warning" role="status"><Bell size={18} /><span>Non-vehicle obstruction: {blocked.map(space => space.code).join(", ")}. These spaces are excluded from availability.</span><button onClick={() => setTab("alerts")}>View alerts</button></div>}
    <div className="workspace-tabs">{tabs.map(({ id, label, icon: Icon }) => <button key={id} aria-pressed={tab === id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}><Icon size={16} />{label}</button>)}</div>
    {tab === 'workspace' && <RegionsTab key={lotId} client={client} session={session} isAdmin={isAdmin} lot={lot} spaces={stalls} config={config} onPublished={onRefresh} />}
    {tab === 'overview' && <CustomerView embedded stalls={stalls} lot={lot} error={parkingError} />}
    {['alerts', 'audit'].includes(tab) && <section className="panel"><div className="section-heading"><h2>{tab === 'alerts' ? 'Active obstruction alerts' : 'Parking-region audit trail'}</h2><button onClick={() => setRefresh(n => n + 1)}>Refresh</button></div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {tab === 'alerts' && <p className="muted">{config?.model?.model?.classes?.includes('blocked') ? 'Accepted blocked observations create warnings for the affected spaces. A later accepted vacant or vehicle-occupied observation resolves the event.' : 'The installed binary model does not generate obstruction warnings yet. Install the trained three-class export to enable them.'}</p>}
      {!items.length && !error && <div className="empty-state">{tab === 'alerts' ? 'No active alerts for this parking area.' : 'No region changes recorded yet.'}</div>}
      {items.map(item => tab === 'alerts' ? <div className="list-row" key={item.id}><div><strong>Space {item.space.code}</strong><p className="muted">Non-vehicle obstruction · opened {age(item.openedAt)}</p></div>{(Array.isArray(item.alert_acknowledgements) ? item.alert_acknowledgements.length > 0 : Boolean(item.alert_acknowledgements)) ? <span className="badge good">Acknowledged</span> : <button onClick={() => acknowledge(item.id)}>Acknowledge</button>}</div> : <details className="audit-row" key={item.id}><summary><strong>{item.action}</strong> · {item.new_values?.id?.slice(0, 8) || item.region_id.slice(0, 8)} <span className="muted">{age(item.changed_at)} · {item.changed_by ? `Account ${item.changed_by.slice(0, 8)}` : 'System'}</span></summary><pre>{JSON.stringify({ before: item.old_values, after: item.new_values }, null, 2)}</pre></details>)}
    </section>}
  </main>;
}
