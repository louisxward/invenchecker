'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// Anything that slips past a handler is logged rather than disappearing or crashing silently
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

// Opening the database runs the schema migrations, before the API or the queues can use it
const db = require('./db');
const { configPath } = require('./config');
const { startScheduler } = require('./scheduler');
const { PORT } = require('./appConfig');
const { createApp } = require('./app');

// Ensure config file exists
const configDir = path.dirname(configPath);
fs.mkdirSync(configDir, { recursive: true });
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, '[]', 'utf8');
  logger.info({ configPath }, 'Created empty accounts.json');
}

// Start the 6-hour scheduler
const schedulerTask = startScheduler();

// Express 5 passes listen errors (such as the port being in use) to this callback
const server = createApp().listen(PORT, (err) => {
  if (err) {
    logger.fatal({ err, port: PORT }, 'API server failed to start');
    process.exit(1);
  }
  logger.info({ port: PORT }, 'invenchecker started');
});

// Graceful shutdown. Forces an exit if that takes longer than Docker's 10 second stop timeout allows.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down...');
  setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, 8000).unref();
  schedulerTask.stop();
  server.close(() => {
    db.close();
    logger.info('Shutdown complete');
    process.exit(0);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
