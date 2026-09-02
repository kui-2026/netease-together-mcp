import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class HistoryStore {
  constructor({ file, clock = () => Date.now() }) {
    this.file = file;
    this.clock = clock;
    this.sessions = [];
    this.ready = this.load();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, sessions: this.sessions }, null, 2), 'utf8');
    await rename(temporary, this.file);
  }

  async start(snapshot) {
    await this.ready;
    const item = {
      roomId: snapshot.roomId,
      startedAt: new Date(this.clock()).toISOString(),
      endedAt: null,
      inviterId: snapshot.inviterId,
      inviterNickname: snapshot.nickname,
      invitationUrl: snapshot.invitationUrl,
      songs: [],
      events: [],
      observations: [],
      memory: null,
    };
    this.sessions.push(item);
    await this.record(snapshot.roomId, 'created', snapshot);
    return item;
  }

  async record(roomId, type, data) {
    await this.ready;
    const item = [...this.sessions].reverse().find((entry) => entry.roomId === String(roomId));
    if (!item) return;
    const timestamp = new Date(this.clock()).toISOString();
    const snapshot = data?.local ?? data;
    const songId = snapshot?.songId ? String(snapshot.songId) : null;
    if (songId && !item.songs.some((song) => song.id === songId)) {
      item.songs.push({ id: songId, firstSeenAt: timestamp });
    }
    item.events ??= deriveEvents(item);
    const previousSongId = item.events.findLast?.((event) => event.songId || event.newSongId)?.newSongId ??
      item.events.findLast?.((event) => event.songId)?.songId ?? null;
    if (songId && songId !== previousSongId) {
      item.events.push(previousSongId
        ? { timestamp, action: 'change', oldSongId: previousSongId, newSongId: songId, source: type }
        : { timestamp, action: 'play', songId, source: type });
    }
    if (type !== 'heartbeat') item.observations.push({ timestamp, type, data });
    if (item.observations.length > 2000) item.observations.splice(0, item.observations.length - 2000);
    item.lastObservedAt = timestamp;
    await this.save();
  }

  async finish(roomId, data = {}) {
    await this.record(roomId, 'closed', data);
    const item = [...this.sessions].reverse().find((entry) => entry.roomId === String(roomId));
    if (item) {
      item.endedAt = new Date(this.clock()).toISOString();
      await this.save();
    }
  }

  async list(limit = 20) {
    await this.ready;
    return this.sessions.slice(-Math.max(1, Math.min(Number(limit) || 20, 100))).reverse().map((item) => ({
      roomId: item.roomId,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      inviterId: item.inviterId,
      inviterNickname: item.inviterNickname,
      songs: item.songs ?? [],
      events: item.events?.length ? item.events : deriveEvents(item),
      memory: item.memory ?? null,
      lastObservedAt: item.lastObservedAt ?? null,
    }));
  }

  async saveMemory({ roomId, title, note }) {
    await this.ready;
    const item = roomId
      ? this.sessions.find((entry) => entry.roomId === String(roomId))
      : this.sessions.at(-1);
    if (!item) throw new Error('No Listen Together history entry was found.');
    item.memory = {
      title: title?.trim() || null,
      note: note?.trim() || null,
      savedAt: new Date(this.clock()).toISOString(),
    };
    await this.save();
    return { roomId: item.roomId, memory: item.memory };
  }
}

function deriveEvents(item) {
  const events = [];
  let previousSongId = null;
  for (const observation of item.observations ?? []) {
    const snapshot = observation.data?.local ?? observation.data;
    const songId = snapshot?.songId ? String(snapshot.songId) : null;
    if (!songId || songId === previousSongId) continue;
    events.push(previousSongId
      ? { timestamp: observation.timestamp, action: 'change', oldSongId: previousSongId, newSongId: songId, source: observation.type }
      : { timestamp: observation.timestamp, action: 'play', songId, source: observation.type });
    previousSongId = songId;
  }
  return events;
}
