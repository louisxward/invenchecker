'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const logger = require('../logger');
const { runScan } = require('../scanner');

const ALERT_SELECT = `
  SELECT a.id, n.name AS market_hash_name, a.spike_pct, a.price_at_alert, a.seven_day_low, a.created_at
  FROM alerts a
  JOIN item_names n ON n.id = a.item_id
`;

const RECIPIENT_SELECT = `
  SELECT a.id, n.name AS market_hash_name, a.spike_pct, a.price_at_alert, a.seven_day_low,
         a.created_at, r.id AS recipient_id, r.resolved, r.resolved_at
  FROM alert_recipients r
  JOIN alerts a ON a.id = r.alert_id
  JOIN item_names n ON n.id = a.item_id
`;

// GET /alerts — admin view, all alerts
router.get('/', (req, res) => {
  const alerts = db.prepare(`${ALERT_SELECT} ORDER BY a.created_at DESC`).all();
  res.json(alerts);
});

// GET /alerts/user/:uid — unresolved alerts for a specific uid
router.get('/user/:uid', (req, res) => {
  const alerts = db.prepare(`${RECIPIENT_SELECT} WHERE r.uid = ? AND r.resolved = 0 ORDER BY a.created_at DESC`)
    .all(req.params.uid);
  res.json(alerts);
});

// PUT /alerts/recipients/:id/resolve — resolve one recipient row
router.put('/recipients/:id/resolve', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const recipient = db.prepare(`${RECIPIENT_SELECT} WHERE r.id = ?`).get(id);
  if (!recipient) return res.status(404).json({ error: 'Recipient not found' });

  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE alert_recipients SET resolved = 1, resolved_at = ? WHERE id = ?').run(now, id);

  res.json({ ...recipient, resolved: 1, resolved_at: now });
});

// PUT /alerts/user/:uid/resolve-all — resolve all unresolved alerts for a uid
router.put('/user/:uid/resolve-all', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const { changes } = db.prepare(
    'UPDATE alert_recipients SET resolved = 1, resolved_at = ? WHERE uid = ? AND resolved = 0'
  ).run(now, req.params.uid);

  res.json({ resolved: changes });
});

// POST /scan — enqueue all accounts for scanning, returns immediately
// ?force=true or body { force: true } bypasses recency checks
router.post('/scan', async (req, res) => {
  try {
    const force = req.query.force === 'true' || req.body?.force === true;
    await runScan(force);
    res.json({ message: 'Scan enqueued', force, queuedAt: Math.floor(Date.now() / 1000) });
  } catch (err) {
    logger.error({ err }, 'Manual scan enqueue failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
