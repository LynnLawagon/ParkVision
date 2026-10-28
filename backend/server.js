const config = require('./config');
const { ModelWorker } = require('./services/modelWorker');
const { InferenceQueue } = require('./services/inferenceQueue');
const { CctvMonitor } = require('./services/cctvMonitor');
const { loadSources } = require('./services/cctvSources');
const { serviceClient } = require('./services/supabase');
const { createApp } = require('./app');
const worker = new InferenceQueue(new ModelWorker());
worker.start();
let sources = [], configError = null;
try { if (config.cctvEnabled) sources = loadSources(config.cctvConfigPath); }
catch (error) { configError = error.message; console.error(configError); }
const monitor = new CctvMonitor({ sources, configError, worker, db: serviceClient,
  minimumConfidence: config.minimumConfidence, ffmpeg: config.ffmpeg });
const server = createApp({ worker, monitor }).listen(config.port, () => {
  console.log(`ParkVision: http://localhost:${config.port}`);
  monitor.startConfigured();
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await monitor.close(); worker.stop(); server.close(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
