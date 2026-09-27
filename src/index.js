'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PORT } = require('./config');
const logger = require('./logger');

// Anything that slips past a handler is logged rather than disappearing or crashing silently
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'process - unhandled rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'process - uncaught exception');
  process.exit(1);
});

// Opening the database runs the schema migrations, before the API or the queues can use it
const db = require('./db');
const { accountsPath } = require('./accountStore');
const { startQueues } = require('./queue');
const { createApp } = require('./app');

// Ensure accounts file exists
fs.mkdirSync(path.dirname(accountsPath), { recursive: true });
if (!fs.existsSync(accountsPath)) {
  fs.writeFileSync(accountsPath, '[]', 'utf8');
  logger.info({ accountsPath }, 'startup - created empty accounts.json');
}

// The queue workers run continuously, each entry re-scanning on its own interval
startQueues();

// Express 5 passes listen errors (such as the port being in use) to this callback
const server = createApp().listen(PORT, (err) => {
  if (err) {
    logger.fatal({ err, port: PORT }, 'startup - api failed to start');
    process.exit(1);
  }
  logger.info({ port: PORT }, 'startup - api listening');
});

// Graceful shutdown. Forces an exit if that takes longer than Docker's 10 second stop timeout allows.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown - start');
  setTimeout(() => {
    logger.error('shutdown - timed out, forcing exit');
    process.exit(1);
  }, 8000).unref();
  server.close(() => {
    db.close();
    logger.info('shutdown - done');
    process.exit(0);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
