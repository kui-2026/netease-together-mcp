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
      cloudsearch: async () => ({ body: { code: 200, result: { songs: [{ id: 1, name: 'Ditto', artists: [{ name: 'NewJeans' }], album: { name: 'Ditto' }, duration: 180000 }] } } }),
    },
  });
  assert.deepEqual(await client.searchSongs('Ditto'), [{ id: '1', name: 'Ditto', artists: 'NewJeans', album: 'Ditto', durationMs: 180000 }]);
});

test('falls back to the legacy search endpoint when cloudsearch fails', async () => {
  const calls = [];
  const client = new NeteaseClient({ cookie: 'MUSIC_U=fake', api: {
    cloudsearch: async () => { calls.push('cloudsearch'); throw { code: 500, msg: 'temporary' }; },
    search: async () => { calls.push('search'); return { body: { code: 200, result: { songs: [{ id: 2, name: 'Fallback', artists: [] }] } } }; },
  } });
  const result = await client.searchSongs('Fallback');
  assert.deepEqual(calls, ['cloudsearch', 'search']);
  assert.equal(result[0].id, '2');
});

test('preserves structured errors when both search endpoints fail', async () => {
  const client = new NeteaseClient({ cookie: 'MUSIC_U=fake', api: {
    cloudsearch: async () => { throw { code: 503, msg: 'cloud unavailable' }; },
    search: async () => { throw { status: 429, body: { message: 'limited' } }; },
  } });
  await assert.rejects(() => client.searchSongs('x'), (error) => {
    assert.equal(error.detail.cloudsearch.code, 503);
    assert.equal(error.detail.legacySearch.status, 429);
    return true;
  });
});

test('resolves song IDs to normalized metadata', async () => {
  const client = new NeteaseClient({ cookie: 'MUSIC_U=fake', api: {
    song_detail: async ({ ids }) => ({ body: { code: 200, songs: [{
      id: Number(ids), name: 'Ref:rain', ar: [{ name: 'Aimer' }],
      al: { name: 'Ref:rain / 眩いばかり', picUrl: 'https://example.test/cover.jpg' }, dt: 290000,
    }] } }),
  } });
  assert.deepEqual(await client.getSongDetails(['536623501']), [{
    id: '536623501', name: 'Ref:rain', artists: 'Aimer', album: 'Ref:rain / 眩いばかり',
    durationMs: 290000, coverUrl: 'https://example.test/cover.jpg',
  }]);
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

test('sends a private message through the enhanced API wrapper', async () => {
  let received;
  const client = new NeteaseClient({ cookie: 'MUSIC_U=fake', api: {
    msg_private_send: async (params) => {
      received = params;
      return { body: { code: 200, msg: 'ok' } };
    },
  } });
  const result = await client.sendPrivateMessage({
    userId: '1461039775',
    message: '一起听邀请：https://st.music.163.com/listen-together/share/?roomId=1',
  });
  assert.equal(result.recipientUserId, '1461039775');
  assert.equal(result.method, 'msg_private_send');
  assert.deepEqual(received, {
    user_ids: '1461039775',
    msg: '一起听邀请：https://st.music.163.com/listen-together/share/?roomId=1',
    type: 'text',
    cookie: 'MUSIC_U=fake',
  });
});

test('does not send private messages when the API wrapper lacks the capability', async () => {
  const client = new NeteaseClient({ cookie: 'MUSIC_U=fake', api: {} });
  await assert.rejects(
    () => client.sendPrivateMessage({ userId: '1', message: 'hello' }),
    /does not expose private-message sending/,
  );
});
