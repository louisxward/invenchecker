'use strict';

const request = require('supertest');
const express = require('express');
const fs = require('fs');

const CONFIG_PATH = process.env.CONFIG_PATH;

function resetConfig(data = []) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data), 'utf8');
}

describe('Accounts routes', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/accounts', require('../../src/routes/accounts'));
  });

  beforeEach(() => {
    resetConfig();
  });

  describe('GET /accounts', () => {
    it('returns empty array when no accounts', async () => {
      const res = await request(app).get('/accounts');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns all accounts', async () => {
      resetConfig([{ uid: 'abc', friendlyName: 'Test', discordId: '1', steam64ids: [], customItems: [] }]);
      const res = await request(app).get('/accounts');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });
  });

  describe('POST /accounts', () => {
    it('creates an account with uid', async () => {
      const res = await request(app).post('/accounts').send({
        friendlyName: 'Main',
        discordId: '111',
        steam64ids: ['76561198000000000'],
      });
      expect(res.status).toBe(201);
      expect(res.body.uid).toBeDefined();
      expect(res.body.friendlyName).toBe('Main');
      expect(res.body.discordId).toBe('111');
    });

    it('returns 400 when friendlyName is missing', async () => {
      const res = await request(app).post('/accounts').send({ discordId: '111', steam64ids: ['123'] });
      expect(res.status).toBe(400);
    });

    it('returns 400 when discordId is missing', async () => {
      const res = await request(app).post('/accounts').send({ friendlyName: 'x', steam64ids: ['123'] });
      expect(res.status).toBe(400);
    });

    it('returns 400 when steam64ids is empty', async () => {
      const res = await request(app).post('/accounts').send({ friendlyName: 'x', discordId: '111', steam64ids: [] });
      expect(res.status).toBe(400);
    });

    it('returns 409 on duplicate discordId', async () => {
      await request(app).post('/accounts').send({ friendlyName: 'A', discordId: '222', steam64ids: ['1'] });
      const res = await request(app).post('/accounts').send({ friendlyName: 'B', discordId: '222', steam64ids: ['2'] });
      expect(res.status).toBe(409);
    });
  });

  describe('POST /accounts/discord', () => {
    it('creates a minimal account', async () => {
      const res = await request(app).post('/accounts/discord').send({ discordId: '999' });
      expect(res.status).toBe(201);
      expect(res.body.uid).toBeDefined();
    });

    it('sets friendlyName when provided', async () => {
      await request(app).post('/accounts/discord').send({ discordId: '998', friendlyName: 'Bot' });
      const all = await request(app).get('/accounts');
      expect(all.body[0].friendlyName).toBe('Bot');
    });

    it('returns 400 when discordId is missing', async () => {
      const res = await request(app).post('/accounts/discord').send({});
      expect(res.status).toBe(400);
    });

    it('returns 409 on duplicate discordId', async () => {
      await request(app).post('/accounts/discord').send({ discordId: '777' });
      const res = await request(app).post('/accounts/discord').send({ discordId: '777' });
      expect(res.status).toBe(409);
    });
  });

  describe('GET /accounts/:uid', () => {
    it('returns the account', async () => {
      const created = (await request(app).post('/accounts').send({
        friendlyName: 'Test', discordId: '333', steam64ids: ['1'],
      })).body;
      const res = await request(app).get(`/accounts/${created.uid}`);
      expect(res.status).toBe(200);
      expect(res.body.uid).toBe(created.uid);
    });

    it('returns 404 for unknown uid', async () => {
      const res = await request(app).get('/accounts/doesnotexist');
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /accounts/:uid', () => {
    it('updates friendlyName', async () => {
      const { uid } = (await request(app).post('/accounts').send({
        friendlyName: 'Old', discordId: '444', steam64ids: ['1'],
      })).body;
      const res = await request(app).put(`/accounts/${uid}`).send({ friendlyName: 'New' });
      expect(res.status).toBe(200);
      expect(res.body.friendlyName).toBe('New');
    });

    it('returns 404 for unknown uid', async () => {
      const res = await request(app).put('/accounts/doesnotexist').send({ friendlyName: 'x' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /accounts/:uid', () => {
    it('deletes an account', async () => {
      const { uid } = (await request(app).post('/accounts').send({
        friendlyName: 'ToDelete', discordId: '555', steam64ids: ['1'],
      })).body;
      expect((await request(app).delete(`/accounts/${uid}`)).status).toBe(204);
      expect((await request(app).get(`/accounts/${uid}`)).status).toBe(404);
    });

    it('returns 404 for unknown uid', async () => {
      expect((await request(app).delete('/accounts/doesnotexist')).status).toBe(404);
    });
  });

  describe('POST /accounts/:uid/steam64ids', () => {
    it('adds a steam64id', async () => {
      const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '601' })).body;
      const res = await request(app).post(`/accounts/${uid}/steam64ids`).send({ steam64id: '76561198000000001' });
      expect(res.status).toBe(200);
      expect(res.body.steam64ids).toContain('76561198000000001');
    });

    it('is a no-op for a duplicate steam64id', async () => {
      const { uid } = (await request(app).post('/accounts').send({
        friendlyName: 'T', discordId: '602', steam64ids: ['76561198000000002'],
      })).body;
      await request(app).post(`/accounts/${uid}/steam64ids`).send({ steam64id: '76561198000000002' });
      const res = await request(app).get(`/accounts/${uid}`);
      expect(res.body.steam64ids).toHaveLength(1);
    });

    it('returns 400 when steam64id is missing', async () => {
      const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '603' })).body;
      const res = await request(app).post(`/accounts/${uid}/steam64ids`).send({});
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /accounts/:uid/steam64ids/:id', () => {
    it('removes a steam64id', async () => {
      const { uid } = (await request(app).post('/accounts').send({
        friendlyName: 'T', discordId: '611', steam64ids: ['76561198000000003'],
      })).body;
      const res = await request(app).delete(`/accounts/${uid}/steam64ids/76561198000000003`);
      expect(res.status).toBe(200);
      expect(res.body.steam64ids).toHaveLength(0);
    });

    it('returns 404 for unknown steam64id', async () => {
      const { uid } = (await request(app).post('/accounts').send({
        friendlyName: 'T', discordId: '612', steam64ids: [],
      })).body;
      const res = await request(app).delete(`/accounts/${uid}/steam64ids/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /accounts/:uid/customItems', () => {
    it('adds a custom item', async () => {
      const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '621' })).body;
      const res = await request(app).post(`/accounts/${uid}/customItems`).send({ item: 'AK-47 | Redline (Field-Tested)' });
      expect(res.status).toBe(200);
      expect(res.body.customItems).toContain('AK-47 | Redline (Field-Tested)');
    });

    it('is a no-op for a duplicate item', async () => {
      const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '622' })).body;
      await request(app).post(`/accounts/${uid}/customItems`).send({ item: 'AWP | Asiimov (Field-Tested)' });
      await request(app).post(`/accounts/${uid}/customItems`).send({ item: 'AWP | Asiimov (Field-Tested)' });
      const res = await request(app).get(`/accounts/${uid}`);
      expect(res.body.customItems).toHaveLength(1);
    });

    it('returns 400 when item is missing', async () => {
      const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '623' })).body;
      const res = await request(app).post(`/accounts/${uid}/customItems`).send({});
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /accounts/:uid/customItems/:item', () => {
    it('removes a custom item', async () => {
      const item = 'M4A4 | Howl (Factory New)';
      const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '631' })).body;
      await request(app).post(`/accounts/${uid}/customItems`).send({ item });
      const res = await request(app).delete(`/accounts/${uid}/customItems/${encodeURIComponent(item)}`);
      expect(res.status).toBe(200);
      expect(res.body.customItems).toHaveLength(0);
    });

    it('returns 404 when item is not on account', async () => {
      const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '632' })).body;
      const res = await request(app).delete(`/accounts/${uid}/customItems/${encodeURIComponent('Nonexistent Item')}`);
      expect(res.status).toBe(404);
    });
  });
});
