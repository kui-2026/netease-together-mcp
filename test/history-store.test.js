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
  assert.equal(session.endedAt, '2026-09-02T10:00:02.000Z');
});
