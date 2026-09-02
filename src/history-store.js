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
      observations: [],
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
    const songId = data?.songId ? String(data.songId) : null;
    if (songId && !item.songs.some((song) => song.id === songId)) {
      item.songs.push({ id: songId, firstSeenAt: timestamp });
    }
    item.observations.push({ timestamp, type, data });
    if (item.observations.length > 2000) item.observations.splice(0, item.observations.length - 2000);
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
    return this.sessions.slice(-Math.max(1, Math.min(Number(limit) || 20, 100))).reverse();
  }
}
