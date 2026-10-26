import React, { useState } from 'react';
import { api } from '../lib/api';
export default function SetupView({ config, error, onRetry }) {
  const [connection, setConnection] = useState(null);
  const [checking, setChecking] = useState(false);
  async function check() {
    setChecking(true);
    try { setConnection(await api('/connection')); }
    catch (error) { setConnection({ error: error.message }); }
    finally { setChecking(false); }
  }
  return <main className="page setup-page">
    <div className="eyebrow">LET’S CONNECT PARKVISION</div>
    <h1>One model. One parking dashboard.</h1>
    <p className="lead">Finish these connections once, then upload a camera frame and define your parking spaces.</p>
    {error && <div className="notice error" role="alert">{error} Start the backend with <code>npm run dev</code> from the project root.</div>}
    <div className="setup-grid">
      <section className="panel"><span className="step-number">01</span><h2>Connect your database</h2>
        <p>Open <code>backend/.env</code> (or copy the example file). Add your Supabase project URL, publishable (or anon) key, and server-only service-role key. In development, saving this file restarts the backend automatically.</p>
        <div className="check-line"><span className={config?.configured ? 'dot good' : 'dot'} />Public connection {config?.configured ? 'configured' : 'needs credentials'}</div>
        <div className="check-line"><span className={config?.writeEnabled ? 'dot good' : 'dot'} />Saving predictions {config?.writeEnabled ? 'configured' : 'needs server key'}</div>
        <button onClick={check} disabled={checking || !config?.configured}>{checking ? 'Checking…' : 'Test database connection'}</button>
        {connection && <p role="status" className={connection.error ? 'error-text' : 'success-text'}>{connection.error || (connection.hasLayout ? 'Connected. Parking layout found.' : 'Connected. Run supabase/seed.sql to create the layout.')}</p>}
      </section>
      <section className="panel"><span className="step-number">02</span><h2>Create your administrator</h2>
        <p>In Supabase, open <strong>Authentication → Users → Add user</strong>. Create an email/password account and confirm the email. Then run this in SQL Editor, using that email:</p>
        <pre>{`update public.profiles
set role_code = 'parking_administrator',
    display_name = 'Parking Administrator'
where id = (
  select id from auth.users
  where email = 'you@example.com'
);`}</pre>
        <p className="muted">New accounts have no personnel privileges until assigned a role. Use Personnel sign-in after this step.</p>
      </section>
      <section className="panel"><span className="step-number">03</span><h2>Load the trained model</h2>
        <p>The exported model belongs in <code>ml/models/parkvision_efficientnetb0.keras</code>. The backend starts its Python worker automatically.</p>
        <div className="check-line"><span className={config?.model?.state === 'ready' ? 'dot good' : 'dot'} />Model: {config?.model?.state || 'backend unavailable'}</div>
        {config?.model?.model && <p className="success-text">{config.model.model.name} · version {config.model.model.version}</p>}
        {config?.model?.error && <p className="error-text">{config.model.error}</p>}
        <p className="muted">The current model predicts empty or occupied. It does not identify non-vehicle obstructions.</p>
      </section>
    </div>
    <button className="primary" onClick={onRetry}>Refresh connection status</button>
  </main>;
}
