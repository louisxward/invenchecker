'use strict';

const { fetchInventory } = require('../src/steam');

function mockResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

describe('fetchInventory pagination', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns all descriptions from a single page', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({
      success: true,
      descriptions: [{ market_hash_name: 'Item A' }, { market_hash_name: 'Item B' }],
      more_items: 0,
    }));

    const result = await fetchInventory('76561198000000001');
    expect(result).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('count=100');
    expect(fetchSpy.mock.calls[0][0]).not.toContain('start_assetid');
  });

  it('fetches multiple pages and accumulates descriptions', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({
        success: true,
        descriptions: [{ market_hash_name: 'Item A' }],
        more_items: 1,
        last_assetid: 'cursor123',
      }))
      .mockResolvedValueOnce(mockResponse({
        success: true,
        descriptions: [{ market_hash_name: 'Item B' }, { market_hash_name: 'Item C' }],
        more_items: 0,
      }));

    const result = await fetchInventory('76561198000000001');
    expect(result).toHaveLength(3);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0]).toContain('start_assetid=cursor123');
  });

  it('throws on HTTP 429', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}, 429));
    await expect(fetchInventory('76561198000000001')).rejects.toThrow('Rate limited');
  });

  it('throws on HTTP 403', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}, 403));
    await expect(fetchInventory('76561198000000001')).rejects.toThrow('Cannot access inventory');
  });

  it('throws on non-ok response', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}, 500));
    await expect(fetchInventory('76561198000000001')).rejects.toThrow('HTTP 500');
  });
});
