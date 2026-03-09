'use strict';

const { startQueues } = require('./queue');
const logger = require('./logger');

function startScheduler() {
  startQueues();
  logger.info('Scheduler started — queue workers running continuously');
  return { stop() {} };
}

module.exports = { startScheduler };
