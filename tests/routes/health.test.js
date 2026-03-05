'use strict';

const request = require('supertest');
const express = require('express');

describe('Health route', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(require('../../src/routes'));
  });

  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns null scan times before any scan has run', async () => {
    const res = await request(app).get('/health');
    expect(res.body.lastScannedAt).toBeNull();
    expect(res.body.lastScanMs).toBeNull();
  });
});
