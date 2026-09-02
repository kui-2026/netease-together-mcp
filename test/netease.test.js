import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRoomId, NeteaseClient } from '../src/netease.js';

test('normalizes enhanced API body responses', async () => {
  const client = new NeteaseClient({
    cookie: 'MUSIC_U=fake',
    api: {
      login_status: async () => ({ body: { code: 200, data: { profile: { userId: 9, nickname: 'x' } } } }),
    },
  });
  assert.deepEqual(await client.accountInfo(), { userId: '9', nickname: 'x' });
});

test('extracts room id from known response shape', () => {
  assert.equal(extractRoomId({ data: { roomInfo: { roomId: 123 } } }), '123');
});

test('normalizes song search results', async () => {
  const client = new NeteaseClient({
    cookie: 'MUSIC_U=fake',
    api: {
      search: async () => ({ body: { code: 200, result: { songs: [{ id: 1, name: 'Ditto', artists: [{ name: 'NewJeans' }], album: { name: 'Ditto' }, duration: 180000 }] } } }),
    },
  });
  assert.deepEqual(await client.searchSongs('Ditto'), [{ id: '1', name: 'Ditto', artists: 'NewJeans', album: 'Ditto', durationMs: 180000 }]);
});
