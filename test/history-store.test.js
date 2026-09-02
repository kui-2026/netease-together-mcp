import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryStore } from '../src/history-store.js';

test('persists listen-together sessions and reloads them', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'netease-history-')), 'history.json');
  let now = Date.parse('2026-09-02T10:00:00Z');
  const store = new HistoryStore({ file, clock: () => now });
  await store.start({ roomId: 'r1', inviterId: '1', nickname: 'small', songId: '10', invitationUrl: 'https://example.test' });
  now += 1000;
  await store.record('r1', 'playback', { songId: '11', playStatus: 'PLAY' });
  now += 1000;
  await store.finish('r1');
  const [session] = await new HistoryStore({ file, clock: () => now }).list();
  assert.deepEqual(session.songs.map((song) => song.id), ['10', '11']);
  assert.deepEqual(session.events.map((event) => event.action), ['play', 'change']);
  assert.equal(session.endedAt, '2026-09-02T10:00:02.000Z');
});

test('compacts legacy heartbeat observations into song-change events and saves a memory', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'netease-history-')), 'history.json');
  const store = new HistoryStore({ file, clock: () => Date.parse('2026-09-02T12:00:00Z') });
  await store.ready;
  store.sessions = [{
    roomId: 'legacy', startedAt: '2026-09-02T08:00:00Z', endedAt: null, songs: [],
    observations: [
      { timestamp: '2026-09-02T08:00:00Z', type: 'heartbeat', data: { songId: '10' } },
      { timestamp: '2026-09-02T08:00:15Z', type: 'heartbeat', data: { songId: '10' } },
      { timestamp: '2026-09-02T08:01:00Z', type: 'heartbeat', data: { songId: '11' } },
    ],
  }];
  const [session] = await store.list();
  assert.deepEqual(session.events.map((event) => event.action), ['play', 'change']);
  assert.equal(session.events[1].newSongId, '11');
  const saved = await store.saveMemory({ roomId: 'legacy', title: '第一次一起听', note: '晚安歌单' });
  assert.equal(saved.memory.title, '第一次一起听');
});
