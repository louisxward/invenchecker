'use strict';

const { fetchInventory, fetchPrice, isNetworkError, isServerError, isInvalidResponse } = require('../src/steam');

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
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        success: true,
        descriptions: [{ market_hash_name: 'Item A' }, { market_hash_name: 'Item B' }],
        more_items: 0,
      })
    );

    const result = await fetchInventory('76561198000000001');
    expect(result).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('count=100');
    expect(fetchSpy.mock.calls[0][0]).not.toContain('start_assetid');
  });

  it('fetches multiple pages and accumulates descriptions', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        mockResponse({
          success: true,
          descriptions: [{ market_hash_name: 'Item A' }],
          more_items: 1,
          last_assetid: 'cursor123',
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          success: true,
          descriptions: [{ market_hash_name: 'Item B' }, { market_hash_name: 'Item C' }],
          more_items: 0,
        })
      );

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

  it('throws on non-ok response, with the status', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}, 500));
    const err = await fetchInventory('76561198000000001').catch((e) => e);
    expect(err.message).toContain('HTTP 500');
    expect(isServerError(err)).toBe(true);
  });

  it('passes a timeout signal to fetch', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ success: true, descriptions: [], more_items: 0 }));
    await fetchInventory('76561198000000001');
    expect(fetchSpy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('fetchPrice', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('parses prices and volume', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ success: true, lowest_price: '£1,234.56', median_price: '£1.20', volume: '1,024' })
    );
    const result = await fetchPrice('AK-47 | Redline (Field-Tested)');
    expect(result).toEqual({ lowest_price: 1234.56, median_price: 1.2, volume: 1024 });
    expect(fetchSpy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('returns null when Steam reports success=false', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ success: false }));
    expect(await fetchPrice('Nope')).toBeNull();
  });
});

describe('isNetworkError', () => {
  it('recognises connection failures and timeouts', async () => {
    const refused = await fetch('http://127.0.0.1:1').catch((err) => err);
    expect(isNetworkError(refused)).toBe(true);
    expect(isNetworkError(new DOMException('timed out', 'TimeoutError'))).toBe(true);
  });

  it('does not treat HTTP errors as network errors', () => {
    expect(isNetworkError(new Error('Failed to fetch price for "x": HTTP 500'))).toBe(false);
    expect(isNetworkError(new Error('Rate limited fetching price for "x"'))).toBe(false);
  });
});

describe('isServerError', () => {
  it('is true for 5xx HTTP errors only', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      fetchSpy.mockResolvedValueOnce(mockResponse({}, 503));
      expect(isServerError(await fetchPrice('x').catch((e) => e))).toBe(true);
      fetchSpy.mockResolvedValueOnce(mockResponse({}, 404));
      expect(isServerError(await fetchPrice('x').catch((e) => e))).toBe(false);
      expect(isServerError(new TypeError('fetch failed'))).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('invalid responses', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('flags a null body', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(null));
    expect(isInvalidResponse(await fetchPrice('x').catch((e) => e))).toBe(true);
    fetchSpy.mockResolvedValueOnce(mockResponse(null));
    expect(isInvalidResponse(await fetchInventory('76561198000000001').catch((e) => e))).toBe(true);
  });

  it('flags a body that is not JSON', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON')),
    });
    const err = await fetchPrice('x').catch((e) => e);
    expect(isInvalidResponse(err)).toBe(true);
    expect(err.message).toContain('invalid JSON');
  });

  it('returns a null lowest price for an item with no listings', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ success: true, median_price: '£0.50', volume: '3' }));
    expect(await fetchPrice('x')).toEqual({ lowest_price: null, median_price: 0.5, volume: 3 });
  });
});
