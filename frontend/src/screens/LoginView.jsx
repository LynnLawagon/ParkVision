import React, { useState } from 'react';
import { LockKeyhole } from 'lucide-react';
export default function LoginView({ client }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <main className="login-page"><form className="login-card" onSubmit={submit}>
    <span className="login-symbol"><LockKeyhole size={25} /></span>
    <div className="eyebrow">PERSONNEL ACCESS</div><h1>Your parking workspace.</h1>
    <p className="muted">Sign in to configure spaces and analyze camera frames.</p>
    <label>Email<input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" /></label>
    <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
    {error && <div className="notice error" role="alert">{error}</div>}
    <button className="primary full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    <p className="small muted">Accounts are created in Supabase Auth. Access is determined by the personnel role assigned to your profile.</p>
  </form></main>;
}
