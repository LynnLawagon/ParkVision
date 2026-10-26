const { publicClient, userClient } = require('../services/supabase');
const MONITOR_ROLES = ['parking_administrator', 'security_personnel', 'parking_personnel'];
function createRequireAuth(authClient = publicClient, makeUserClient = userClient) {
return async function requireAuth(req, res, next) {
  if (!authClient) return res.status(503).json({ error: 'Configure Supabase in backend/.env first.' });
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Sign in required.' });
  try {
    const { data: { user }, error } = await authClient.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Session expired. Sign in again.' });
    req.db = makeUserClient(token);
    const { data: profile, error: profileError } = await req.db.from('profiles').select('id, display_name, role_code').eq('id', user.id).single();
    if (profileError || !MONITOR_ROLES.includes(profile?.role_code)) return res.status(403).json({ error: 'This account needs an approved personnel role.' });
    req.user = user;
    req.profile = profile;
    next();
  } catch (error) { next(error); }
};
}
const requireAuth = createRequireAuth();
function requireAdmin(req, res, next) {
  if (req.profile?.role_code !== 'parking_administrator') return res.status(403).json({ error: 'Parking Administrator access required.' });
  next();
}
module.exports = { requireAuth, requireAdmin, createRequireAuth };
