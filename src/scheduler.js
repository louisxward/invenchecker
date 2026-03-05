'use strict';

const cron = require('node-cron');
const logger = require('./logger');
const { runScan } = require('./scanner');
const { SCAN_CRON } = require('./appConfig');

function startScheduler() {
  const task = cron.schedule(SCAN_CRON, () => {
    runScan().catch((err) => logger.error({ err }, 'Scheduled scan failed'));
  });

  logger.info('Scheduler started — scans run every 6 hours');
  return task;
}

module.exports = { startScheduler };
