'use strict';

const request = require('supertest');
const express = require('express');

const { setAccounts } = require('../helpers/accounts');

describe('Accounts routes', () => {
  let app;

  beforeAll(() => {
    require('../../src/database').init();
    app = express();
    app.use(express.json());
    app.use('/accounts', require('../../src/routes/accounts'));
  });

  beforeEach(() => {
    setAccounts([]);
  });

  describe('GET /accounts', () => {
    it('returns empty array when no accounts', async () => {
      const res = await request(app).get('/accounts');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns all accounts', async () => {
      setAccounts([{ uid: 'abc', friendlyName: 'Test', discordId: '1', steam64ids: [], customItems: [] }]);
      const res = await request(app).get('/accounts');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });
  });

  describe('POST /accounts', () => {
    it('creates an account with uid', async () => {
      const res = await request(app)
        .post('/accounts')
        .send({
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
      const res = await request(app)
        .post('/accounts')
        .send({ discordId: '111', steam64ids: ['123'] });
      expect(res.status).toBe(400);
    });

    it('returns 400 when discordId is missing', async () => {
      const res = await request(app)
        .post('/accounts')
        .send({ friendlyName: 'x', steam64ids: ['123'] });
      expect(res.status).toBe(400);
    });

    it('returns 400 when steam64ids is empty', async () => {
      const res = await request(app).post('/accounts').send({ friendlyName: 'x', discordId: '111', steam64ids: [] });
      expect(res.status).toBe(400);
    });

    it('returns 409 on duplicate discordId', async () => {
      await request(app)
        .post('/accounts')
        .send({ friendlyName: 'A', discordId: '222', steam64ids: ['76561198000000010'] });
      const res = await request(app)
        .post('/accounts')
        .send({ friendlyName: 'B', discordId: '222', steam64ids: ['76561198000000011'] });
      expect(res.status).toBe(409);
    });
  });

  describe('requests without a JSON body', () => {
    it('POST /accounts returns 400', async () => {
      const res = await request(app).post('/accounts');
      expect(res.status).toBe(400);
    });

    it('POST /accounts/discord returns 400', async () => {
      const res = await request(app).post('/accounts/discord');
      expect(res.status).toBe(400);
    });

    it('PUT /accounts/:uid leaves the account unchanged', async () => {
      const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '501', friendlyName: 'Same' }))
        .body;
      const res = await request(app).put(`/accounts/${uid}`);
      expect(res.status).toBe(200);
      expect(res.body.friendlyName).toBe('Same');
    });

    it('POST /accounts/:uid/steam64ids returns 400', async () => {
      const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '502' })).body;
      const res = await request(app).post(`/accounts/${uid}/steam64ids`);
      expect(res.status).toBe(400);
    });

    it('POST /accounts/:uid/customItems returns 400', async () => {
      const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '503' })).body;
      const res = await request(app).post(`/accounts/${uid}/customItems`);
      expect(res.status).toBe(400);
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
      const created = (
        await request(app)
          .post('/accounts')
          .send({
            friendlyName: 'Test',
            discordId: '333',
            steam64ids: ['76561198000000010'],
          })
      ).body;
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
      const { uid } = (
        await request(app)
          .post('/accounts')
          .send({
            friendlyName: 'Old',
            discordId: '444',
            steam64ids: ['76561198000000010'],
          })
      ).body;
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
      const { uid } = (
        await request(app)
          .post('/accounts')
          .send({
            friendlyName: 'ToDelete',
            discordId: '555',
            steam64ids: ['76561198000000010'],
          })
      ).body;
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
      const { uid } = (
        await request(app)
          .post('/accounts')
          .send({
            friendlyName: 'T',
            discordId: '602',
            steam64ids: ['76561198000000002'],
          })
      ).body;
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
      const { uid } = (
        await request(app)
          .post('/accounts')
          .send({
            friendlyName: 'T',
            discordId: '611',
            steam64ids: ['76561198000000003'],
          })
      ).body;
      const res = await request(app).delete(`/accounts/${uid}/steam64ids/76561198000000003`);
      expect(res.status).toBe(200);
      expect(res.body.steam64ids).toHaveLength(0);
    });

    it('returns 404 for unknown steam64id', async () => {
      const { uid } = (
        await request(app).post('/accounts').send({
          friendlyName: 'T',
          discordId: '612',
          steam64ids: [],
        })
      ).body;
      const res = await request(app).delete(`/accounts/${uid}/steam64ids/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /accounts/:uid/customItems', () => {
    it('adds a custom item', async () => {
      const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '621' })).body;
      const res = await request(app)
        .post(`/accounts/${uid}/customItems`)
        .send({ item: 'AK-47 | Redline (Field-Tested)' });
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

  describe('input validation', () => {
    it('POST /accounts rejects customItems that is not an array of names', async () => {
      for (const customItems of ['AK-47 | Redline (Field-Tested)', [1], ['']]) {
        const res = await request(app)
          .post('/accounts')
          .send({ friendlyName: 'x', discordId: '701', steam64ids: ['76561198000000010'], customItems });
        expect(res.status).toBe(400);
      }
      expect((await request(app).get('/accounts')).body).toHaveLength(0);
    });

    it('PUT /accounts/:uid rejects steam64ids or customItems that are not arrays', async () => {
      const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '702' })).body;
      expect((await request(app).put(`/accounts/${uid}`).send({ steam64ids: '76561198000000010' })).status).toBe(400);
      expect((await request(app).put(`/accounts/${uid}`).send({ customItems: 'x' })).status).toBe(400);
      const account = (await request(app).get(`/accounts/${uid}`)).body;
      expect(account.steam64ids).toEqual([]);
      expect(account.customItems).toEqual([]);
    });

    it('PUT /accounts/:uid returns 409 when the discordId belongs to another account', async () => {
      await request(app).post('/accounts/discord').send({ discordId: '703' });
      const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '704' })).body;
      expect((await request(app).put(`/accounts/${uid}`).send({ discordId: '703' })).status).toBe(409);
      expect((await request(app).put(`/accounts/${uid}`).send({ discordId: '704' })).status).toBe(200);
    });

    it('rejects a friendlyName or discordId that is not a string', async () => {
      const valid = { friendlyName: 'x', discordId: '710', steam64ids: ['76561198000000010'] };
      expect(
        (
          await request(app)
            .post('/accounts')
            .send({ ...valid, friendlyName: 5 })
        ).status
      ).toBe(400);
      expect(
        (
          await request(app)
            .post('/accounts')
            .send({ ...valid, discordId: true })
        ).status
      ).toBe(400);
      expect((await request(app).post('/accounts/discord').send({ discordId: 711 })).status).toBe(400);
      expect((await request(app).post('/accounts/discord').send({ discordId: '712', friendlyName: {} })).status).toBe(
        400
      );
      const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '713' })).body;
      expect((await request(app).put(`/accounts/${uid}`).send({ friendlyName: 1 })).status).toBe(400);
      expect((await request(app).put(`/accounts/${uid}`).send({ discordId: '' })).status).toBe(400);
      expect((await request(app).put(`/accounts/${uid}`).send({ friendlyName: null })).status).toBe(200);
      expect((await request(app).get('/accounts')).body.map((a) => a.discordId)).toEqual(['713']);
    });

    it('POST /accounts/:uid/customItems rejects a non-string item', async () => {
      const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '705' })).body;
      expect(
        (
          await request(app)
            .post(`/accounts/${uid}/customItems`)
            .send({ item: { a: 1 } })
        ).status
      ).toBe(400);
    });
  });

  describe('accounts without steam64ids or customItems', () => {
    beforeEach(() => setAccounts([{ uid: 'bare', friendlyName: 'Bare', discordId: '801' }]));

    it('can add a steam64id', async () => {
      const res = await request(app).post('/accounts/bare/steam64ids').send({ steam64id: '76561198000000020' });
      expect(res.status).toBe(200);
      expect(res.body.steam64ids).toEqual(['76561198000000020']);
    });

    it('can add a custom item', async () => {
      const res = await request(app).post('/accounts/bare/customItems').send({ item: 'AWP | Asiimov (Field-Tested)' });
      expect(res.status).toBe(200);
      expect(res.body.customItems).toEqual(['AWP | Asiimov (Field-Tested)']);
    });

    it('returns 404 when removing entries', async () => {
      expect((await request(app).delete('/accounts/bare/steam64ids/76561198000000020')).status).toBe(404);
      expect((await request(app).delete('/accounts/bare/customItems/x')).status).toBe(404);
    });

    it('returns an empty live inventory', async () => {
      const res = await request(app).get('/accounts/bare/inventory');
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(0);
    });
  });

  it('DELETE /accounts/:uid/customItems/:item handles names containing %', async () => {
    const item = 'Sticker | 100% Pure (Foil)';
    const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '901' })).body;
    await request(app).post(`/accounts/${uid}/customItems`).send({ item });
    const res = await request(app).delete(`/accounts/${uid}/customItems/${encodeURIComponent(item)}`);
    expect(res.status).toBe(200);
    expect(res.body.customItems).toEqual([]);
  });

  it('DELETE /accounts/:uid stops its steam64ids and custom items being tracked', async () => {
    const accounts = require('../../src/repositories/accounts');
    const { uid } = (
      await request(app)
        .post('/accounts')
        .send({ friendlyName: 'T', discordId: '920', steam64ids: ['76561198000000021'], customItems: ['Gone Item'] })
    ).body;
    expect(accounts.isSteam64idTracked('76561198000000021')).toBe(true);
    await request(app).delete(`/accounts/${uid}`);
    expect(accounts.isSteam64idTracked('76561198000000021')).toBe(false);
    expect(accounts.isCustomItemTracked('Gone Item')).toBe(false);
  });

  it('PUT keeps list order and repeats, and DELETE removes the first repeat only', async () => {
    const { uid } = (await request(app).post('/accounts/discord').send({ discordId: '921' })).body;
    await request(app)
      .put(`/accounts/${uid}`)
      .send({ customItems: ['B', 'A', 'B'] });
    await request(app).post(`/accounts/${uid}/customItems`).send({ item: 'C' });
    expect((await request(app).get(`/accounts/${uid}`)).body.customItems).toEqual(['B', 'A', 'B', 'C']);
    const res = await request(app).delete(`/accounts/${uid}/customItems/B`);
    expect(res.body.customItems).toEqual(['A', 'B', 'C']);
  });
});
