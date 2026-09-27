'use strict';

const express = require('express');
const logger = require('../logger');
const alertRecipients = require('../repositories/alertRecipients');
const alerts = require('../repositories/alerts');
const { runScan } = require('../scanner');

const router = express.Router();

// GET /alerts — admin view, all alerts
router.get('/', (req, res) => {
  res.json(alerts.listAlerts());
});

// GET /alerts/user/:uid — unresolved alerts for a specific uid
router.get('/user/:uid', (req, res) => {
  res.json(alertRecipients.listUnresolvedForUid(req.params.uid));
});

// PUT /alerts/recipients/:id/resolve — resolve one recipient row
router.put('/recipients/:id/resolve', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const recipient = alertRecipients.getRecipient(id);
  if (!recipient) return res.status(404).json({ error: 'Recipient not found' });

  const now = Math.floor(Date.now() / 1000);
  alertRecipients.resolveRecipient(id, now);

  res.json({ ...recipient, resolved: 1, resolved_at: now });
});

// PUT /alerts/user/:uid/resolve-all — resolve all unresolved alerts for a uid
router.put('/user/:uid/resolve-all', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  res.json({ resolved: alertRecipients.resolveAllForUid(req.params.uid, now) });
});

// POST /scan — enqueue all accounts for scanning, returns immediately
// ?force=true or body { force: true } bypasses recency checks
router.post('/scan', async (req, res) => {
  try {
    const force = req.query.force === 'true' || req.body?.force === true;
    await runScan(force);
    res.json({ message: 'Scan enqueued', force, queuedAt: Math.floor(Date.now() / 1000) });
  } catch (err) {
    logger.error({ err }, 'scan - manual enqueue failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
