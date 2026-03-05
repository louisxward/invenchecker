'use strict';

const express = require('express');
const router = express.Router();
const { scanState } = require('../scanner');

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', lastScannedAt: scanState.lastScannedAt, lastScanMs: scanState.lastScanMs });
});

router.use('/accounts', require('./accounts'));
router.use('/alerts', require('./alerts'));

module.exports = router;
