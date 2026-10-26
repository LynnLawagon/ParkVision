const config = require('./config');
const { ModelWorker } = require('./services/modelWorker');
const { createApp } = require('./app');
const worker = new ModelWorker();
worker.start();
const server = createApp({ worker }).listen(config.port, () => console.log(`ParkVision: http://localhost:${config.port}`));
function stop() { worker.stop(); server.close(() => process.exit(0)); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
