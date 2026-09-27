'use strict';

const express = require('express');
const logger = require('./logger');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(require('./routes'));

  // Global error handler
  app.use((err, req, res, _next) => {
    logger.error({ err, path: req.path }, 'api - unhandled request error');
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });
  return app;
}

module.exports = { createApp };
