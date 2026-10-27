const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const configured = Boolean(config.supabaseUrl && config.publishableKey);
const publicClient = configured ? createClient(config.supabaseUrl, config.publishableKey, options) : null;
const serviceClient = configured && config.serviceKey && !config.publicationError ? createClient(config.supabaseUrl, config.serviceKey, options) : null;
function userClient(token) {
  return createClient(config.supabaseUrl, config.publishableKey, { ...options, global: { headers: { Authorization: `Bearer ${token}` } } });
}
module.exports = { publicClient, serviceClient, userClient, configured };
