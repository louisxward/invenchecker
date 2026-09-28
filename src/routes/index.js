'use strict';

const express = require('express');
const router = express.Router();
const { getQueueState } = require('../queue');
const { scanState } = require('../scanner');

router.get('/health', (_req, res) => {
  const { inventoryQueueSize, priceQueueSize } = getQueueState();
  res.json({
    status: 'ok',
    lastScannedAt: scanState.lastScannedAt,
    lastScanMs: scanState.lastScanMs,
    inventoryQueueSize,
    priceQueueSize,
  });
});

router.use('/accounts', require('./accounts'));
router.use('/alerts', require('./alerts'));

module.exports = router;
