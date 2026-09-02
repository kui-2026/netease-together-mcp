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

test('combines visible user profile data and listening records', async () => {
  const client = new NeteaseClient({ cookie: 'MUSIC_U=fake', api: {
    user_detail: async () => ({ body: { code: 200, level: 9, profile: { userId: 1461039775, nickname: 'main' } } }),
    user_playlist: async () => ({ body: { code: 200, playlist: [{ id: 8, name: '公开歌单', trackCount: 3, privacy: 0 }] } }),
    user_record: async ({ type }) => ({ body: { code: 200, [type === 1 ? 'weekData' : 'allData']: [{ song: { id: 2, name: 'song', ar: [{ name: 'artist' }] }, playCount: 4, score: 99 }] } }),
  } });
  const result = await client.getUserProfile('1461039775');
  assert.equal(result.nickname, 'main');
  assert.equal(result.playlists[0].name, '公开歌单');
  assert.equal(result.weeklyListening.songs[0].artists, 'artist');
});
