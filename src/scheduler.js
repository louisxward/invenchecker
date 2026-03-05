'use strict';

const cron = require('node-cron');
const logger = require('./logger');
const { runScan } = require('./scanner');

function startScheduler() {
  // Run at minute 0 of every 6th hour: 00:00, 06:00, 12:00, 18:00
  const task = cron.schedule('0 */6 * * *', () => {
    runScan().catch((err) => logger.error({ err }, 'Scheduled scan failed'));
  });

  logger.info('Scheduler started — scans run every 6 hours');
  return task;
}

module.exports = { startScheduler };
