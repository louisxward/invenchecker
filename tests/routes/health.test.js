'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');

describe('Health route', () => {
  let app;

  beforeAll(() => {
    app = createApp();
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

  it('returns 400 with the parser message for malformed JSON', async () => {
    const res = await request(app).post('/accounts').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JSON/);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
  });
});
