function keyKind(key) {
  if (!key) return 'missing';
  if (key.startsWith('sb_publishable_')) return 'publishable';
  if (key.startsWith('sb_secret_')) return 'secret';
  try {
    return JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString()).role || 'unknown';
  } catch { return 'unknown'; }
}
function serverKeyProblem(key, publicKey) {
  if (!key) return '';
  if (key === publicKey || ['publishable', 'anon'].includes(keyKind(key))) {
    return 'The server-key field contains a publishable/anon key. Replace SUPABASE_SERVICE_ROLE_KEY in backend/.env with a Supabase secret key (sb_secret_...) or legacy service_role key.';
  }
  return '';
}
module.exports = { keyKind, serverKeyProblem };
