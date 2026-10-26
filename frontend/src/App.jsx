import React, { useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { CarFront, Settings2, LogOut } from 'lucide-react';
import { useFonts } from './useFonts';
import { api, unwrap, roleNames } from './lib/api';
import CustomerView from './screens/CustomerView';
import LoginView from './screens/LoginView';
import AdminView from './screens/AdminView';
import SetupView from './screens/SetupView';
import './styles/app.css';

export default function App() {
  useFonts();
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState('');
  const [screen, setScreen] = useState('customer');
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileRefresh, setProfileRefresh] = useState(0);
  const [lots, setLots] = useState([]);
  const [lotId, setLotId] = useState('');
  const [stalls, setStalls] = useState([]);
  const [parkingError, setParkingError] = useState('');
  const [parkingLoading, setParkingLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const client = useMemo(() => config?.configured ? createClient(config.supabaseUrl, config.publishableKey) : null, [config?.supabaseUrl, config?.publishableKey, config?.configured]);
  async function loadConfig() {
    try { setConfig(await api('/config')); setConfigError(''); }
    catch (error) { setConfigError(error.message === 'Failed to fetch' ? 'The backend is not reachable.' : error.message); }
  }
  useEffect(() => { loadConfig(); const timer = setInterval(loadConfig, 10000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!client) return;
    let active = true;
    client.auth.getSession().then(({ data }) => { if (active) setSession(data.session); });
    const { data: { subscription } } = client.auth.onAuthStateChange((event, next) => { if (active) setSession(next); });
    return () => { active = false; subscription.unsubscribe(); };
  }, [client]);
  useEffect(() => {
    let active = true;
    setProfile(null); setProfileError('');
    if (!session || !client) { setProfileLoading(false); return; }
    setProfileLoading(true);
    client.from('profiles').select('id, display_name, role_code').eq('id', session.user.id).single().then(response => {
      if (!active) return;
      if (response.error) setProfileError('Could not load your personnel profile. Check the database setup.');
      else setProfile(response.data);
      setProfileLoading(false);
    });
    return () => { active = false; };
  }, [client, session?.access_token, profileRefresh]);
  useEffect(() => {
    if (!client) return;
    let active = true;
    client.from('parking_lots').select('*').eq('is_active', true).order('code').then(response => {
      if (!active) return;
      if (response.error) { setParkingError(response.error.message); setParkingLoading(false); return; }
      setLots(response.data);
      setLotId(current => response.data.some(lot => lot.id === current) ? current : (response.data.find(lot => lot.code === 'LUZANO') || response.data[0])?.id || '');
      if (!response.data.length) setParkingLoading(false);
    });
    return () => { active = false; };
  }, [client, refresh]);
  useEffect(() => {
    if (!client || !lotId) return;
    let active = true, timer;
    setParkingLoading(true); setStalls([]);
    async function poll() {
      try {
        const rows = unwrap(await client.from('parking_status').select('*').eq('parking_lot_id', lotId));
        if (active) { setStalls(rows.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))); setParkingError(''); }
      } catch (error) { if (active) setParkingError(error.message); }
      finally { if (active) { setParkingLoading(false); timer = setTimeout(poll, 2000); } }
    }
    poll();
    return () => { active = false; clearTimeout(timer); };
  }, [client, lotId, refresh]);
  const monitor = Boolean(roleNames[profile?.role_code]);
  const lot = lots.find(item => item.id === lotId);
  async function signOut() { await client.auth.signOut(); setProfile(null); setScreen('customer'); }
  const setup = screen === 'setup' || (!client && (config || configError));
  return <div className="app-shell">
    <header className="topbar"><button className="brand" onClick={() => setScreen('customer')}><span className="brand-mark"><CarFront size={21} /></span>ParkVision<span className="brand-tag">PARKING MONITOR</span></button>
      <nav aria-label="Main navigation"><button className={screen === 'customer' ? 'nav-active' : 'quiet'} onClick={() => setScreen('customer')}>Availability</button>
        <button className={screen === 'personnel' ? 'nav-active' : 'quiet'} onClick={() => setScreen('personnel')}>{session ? 'Personnel workspace' : 'Personnel sign-in'}</button>
        <button className="icon-button" aria-label="Connection setup" onClick={() => setScreen('setup')}><Settings2 size={18} /></button>
        {session && <button className="icon-button" aria-label="Sign out" onClick={signOut}><LogOut size={17} /></button>}
      </nav></header>
    {setup ? <SetupView config={config} error={configError} onRetry={() => { loadConfig(); setRefresh(n => n + 1); }} />
      : !config ? <main className="page"><p className="muted">Connecting to ParkVision…</p></main>
      : screen === 'personnel' ? !session ? <LoginView client={client} /> : profileLoading ? <main className="page">Loading your profile…</main> : !monitor ? <main className="page"><div className="panel"><h1>Your account needs a personnel role</h1><p>{profileError || 'An administrator must assign your profile a role before you can monitor or configure parking.'}</p><button onClick={() => setScreen('setup')}>View administrator setup</button><button onClick={() => setProfileRefresh(n => n + 1)}>Refresh access</button></div></main>
        : <AdminView client={client} session={session} profile={profile} lot={lot} lots={lots} lotId={lotId} onLotChange={setLotId} stalls={stalls} config={config} onRefresh={() => setRefresh(n => n + 1)} parkingError={parkingError} />
      : <CustomerView stalls={stalls} lot={lot} lots={lots} lotId={lotId} onLotChange={setLotId} loading={parkingLoading} error={parkingError} onSetup={() => setScreen('setup')} />}
    <footer className="site-footer">ParkVision · Luzano Compound <span>Availability is based on the latest analyzed frame.</span></footer>
  </div>;
}
