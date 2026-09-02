import test from 'node:test';
import assert from 'node:assert/strict';
import { ListenTogetherSessionManager } from '../src/session-manager.js';

class FakeClient {
  constructor() {
    this.calls = [];
  }
  async accountInfo() { return { userId: '42', nickname: 'small-account' }; }
  async createRoom() { return { code: 200, data: { roomInfo: { roomId: 'room-7' } } }; }
  async replaceRoomPlaylist(args) { this.calls.push(['playlist', args]); return { code: 200 }; }
  async sendPlayCommand(args) { this.calls.push(['command', args]); return { code: 200 }; }
  async heartbeat(args) { this.calls.push(['heartbeat', args]); return { code: 200 }; }
  async checkRoom(roomId) { return { code: 200, roomId }; }
  async getRoomPlaylist(roomId) { return { code: 200, roomId, songs: ['100'] }; }
  async endRoom(roomId) { this.calls.push(['end', roomId]); return { code: 200 }; }
}

test('creates a room and returns an official invitation URL', async () => {
  let now = 1_000;
  const client = new FakeClient();
  const manager = new ListenTogetherSessionManager({
    client,
    heartbeatMs: 60_000,
    clock: () => now,
  });
  const result = await manager.create('100');
  assert.equal(result.roomId, 'room-7');
  assert.match(result.invitationUrl, /songId=100/);
  assert.match(result.invitationUrl, /inviterId=42/);
  assert.equal(result.lastHeartbeatError, null);
  manager.stopHeartbeatLoop();
});

test('tracks play progress and sends pause command', async () => {
  let now = 5_000;
  const client = new FakeClient();
  const manager = new ListenTogetherSessionManager({ client, heartbeatMs: 60_000, clock: () => now });
  await manager.create('100');
  await manager.control({ action: 'PLAY', songId: '100', progressMs: 2_000 });
  now += 3_000;
  assert.equal(manager.snapshot().progressMs, 5_000);
  await manager.control({ action: 'PAUSE' });
  assert.equal(manager.snapshot().playStatus, 'PAUSE');
  assert.equal(manager.snapshot().progressMs, 5_000);
  manager.stopHeartbeatLoop();
});

test('closes the active room and stops the session', async () => {
  const client = new FakeClient();
  const manager = new ListenTogetherSessionManager({ client, heartbeatMs: 60_000 });
  await manager.create('100');
  const result = await manager.close();
  assert.equal(result.closed, true);
  assert.deepEqual(manager.snapshot(), { active: false });
});
