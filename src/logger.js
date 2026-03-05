'use strict';

const pino = require('pino');
const { LOG_LEVEL } = require('./appConfig');

const logger = pino(
  { level: LOG_LEVEL },
  process.env.NODE_ENV === 'development'
    ? pino.transport({ target: 'pino-pretty', options: { colorize: true } })
    : undefined
);

module.exports = logger;
