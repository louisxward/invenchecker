'use strict';

const request = require('supertest');
const express = require('express');

describe('Alerts routes', () => {
  let app;
  let db;

  beforeAll(() => {
    db = require('../../src/db');
    app = express();
    app.use(express.json());
    app.use('/alerts', require('../../src/routes/alerts'));
  });

  beforeEach(() => {
    db.prepare('DELETE FROM alert_recipients').run();
    db.prepare('DELETE FROM alerts').run();
  });

  function insertAlert(itemName, uid) {
    const itemId = db.getOrCreateItemId(itemName);
    const now = Math.floor(Date.now() / 1000);
    const alertId = db.prepare(
      'INSERT INTO alerts (item_id, spike_pct, price_at_alert, seven_day_low, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(itemId, 20.0, 12.0, 10.0, now).lastInsertRowid;
    const recipientId = db.prepare(
      'INSERT INTO alert_recipients (alert_id, uid) VALUES (?, ?)'
    ).run(alertId, uid).lastInsertRowid;
    return { alertId, recipientId };
  }

  describe('GET /alerts', () => {
    it('returns empty array when no alerts', async () => {
      const res = await request(app).get('/alerts');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns all alerts', async () => {
      insertAlert('AK-47 | Redline (Field-Tested)', 'uid1');
      insertAlert('AWP | Asiimov (Field-Tested)', 'uid2');
      const res = await request(app).get('/alerts');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('includes market_hash_name and spike data', async () => {
      insertAlert('AK-47 | Redline (Field-Tested)', 'uid1');
      const res = await request(app).get('/alerts');
      expect(res.body[0].market_hash_name).toBe('AK-47 | Redline (Field-Tested)');
      expect(res.body[0].spike_pct).toBe(20.0);
      expect(res.body[0].price_at_alert).toBe(12.0);
      expect(res.body[0].seven_day_low).toBe(10.0);
    });
  });

  describe('GET /alerts/user/:uid', () => {
    it('returns unresolved alerts for the uid', async () => {
      insertAlert('Glock-18 | Fade (Factory New)', 'userA');
      const res = await request(app).get('/alerts/user/userA');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].resolved).toBe(0);
    });

    it('does not return alerts for other uids', async () => {
      insertAlert('USP-S | Kill Confirmed (Field-Tested)', 'userB');
      const res = await request(app).get('/alerts/user/userC');
      expect(res.body).toHaveLength(0);
    });

    it('does not return resolved alerts', async () => {
      const { recipientId } = insertAlert('M4A1-S | Hyper Beast (Field-Tested)', 'userD');
      db.prepare('UPDATE alert_recipients SET resolved = 1 WHERE id = ?').run(recipientId);
      const res = await request(app).get('/alerts/user/userD');
      expect(res.body).toHaveLength(0);
    });
  });

  describe('PUT /alerts/recipients/:id/resolve', () => {
    it('resolves a recipient', async () => {
      const { recipientId } = insertAlert('Desert Eagle | Blaze (Factory New)', 'userE');
      const res = await request(app).put(`/alerts/recipients/${recipientId}/resolve`);
      expect(res.status).toBe(200);
      expect(res.body.resolved).toBe(1);
      expect(res.body.resolved_at).toBeDefined();
    });

    it('returns 404 for unknown recipient id', async () => {
      const res = await request(app).put('/alerts/recipients/99999/resolve');
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /alerts/user/:uid/resolve-all', () => {
    it('resolves all unresolved alerts for a uid', async () => {
      insertAlert('P250 | Sand Dune (Field-Tested)', 'userF');
      insertAlert('Tec-9 | Fuel Injector (Factory New)', 'userF');
      const res = await request(app).put('/alerts/user/userF/resolve-all');
      expect(res.status).toBe(200);
      expect(res.body.resolved).toBe(2);
      const check = await request(app).get('/alerts/user/userF');
      expect(check.body).toHaveLength(0);
    });

    it('returns 0 when no unresolved alerts exist', async () => {
      const res = await request(app).put('/alerts/user/nobody/resolve-all');
      expect(res.status).toBe(200);
      expect(res.body.resolved).toBe(0);
    });
  });
});
