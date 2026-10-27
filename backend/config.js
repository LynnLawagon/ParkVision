const path = require('node:path');
const os = require('node:os');
const { keyKind, serverKeyProblem } = require('./keyValidation');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const clean = value => value && !value.includes('YOUR_') ? value.trim() : '';
const config = {
  port: Number(process.env.PORT) || 4000,
  origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  supabaseUrl: clean(process.env.SUPABASE_URL),
  publishableKey: clean(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY),
  serviceKey: clean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  python: process.env.ML_PYTHON || path.join(os.homedir(), '.venvs/parkvision-ml/bin/python'),
  modelPath: process.env.MODEL_PATH || path.resolve(__dirname, '../ml/models/parkvision_efficientnetb0.keras'),
  minimumConfidence: Number(process.env.MINIMUM_CONFIDENCE || 0.8),
};
if (['secret', 'service_role'].includes(keyKind(config.publishableKey))) throw new Error('SUPABASE_PUBLISHABLE_KEY must be the public publishable/anon key, never a secret or service-role key.');
config.publicationError = serverKeyProblem(config.serviceKey, config.publishableKey);
if (!Number.isFinite(config.minimumConfidence) || config.minimumConfidence < 0.5 || config.minimumConfidence > 1) throw new Error('MINIMUM_CONFIDENCE must be between 0.5 and 1.');
module.exports = config;
