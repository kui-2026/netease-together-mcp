import { extractRoomId } from './netease.js';

const VALID_ACTIONS = new Set(['GOTO', 'PLAY', 'PAUSE', 'SEEK']);

export class ListenTogetherSessionManager {
  constructor({ client, heartbeatMs = 15_000, clock = () => Date.now(), history = null }) {
    this.client = client;
    this.heartbeatMs = heartbeatMs;
    this.clock = clock;
    this.session = null;
    this.timer = null;
    this.heartbeatInFlight = false;
    this.lastHeartbeatError = null;
    this.history = history;
  }

  snapshot() {
    if (!this.session) return { active: false };
    return {
      active: true,
      roomId: this.session.roomId,
      inviterId: this.session.userId,
      nickname: this.session.nickname,
      songId: this.session.songId,
      playStatus: this.session.playStatus,
      progressMs: this.currentProgress(),
      playlist: [...this.session.playlist],
      invitationUrl: this.session.invitationUrl,
      heartbeatMs: this.heartbeatMs,
      lastHeartbeatAt: this.session.lastHeartbeatAt,
      lastHeartbeatError: this.lastHeartbeatError,
    };
  }

  currentProgress() {
    if (!this.session) return 0;
    if (this.session.playStatus !== 'PLAY') return this.session.progressMs;
    return Math.max(
      0,
      this.session.progressMs + (this.clock() - this.session.progressUpdatedAt),
    );
  }

  async create(initialSongId) {
    if (this.session) {
      throw new Error('A Listen Together room is already active. Close it first.');
    }
    const account = await this.client.accountInfo();
    const roomBody = await this.client.createRoom();
    const roomId = extractRoomId(roomBody);
    const songId = String(initialSongId);
    const now = this.clock();
    this.session = {
      roomId,
      userId: account.userId,
      nickname: account.nickname,
      songId,
      formerSongId: '-1',
      playStatus: 'PAUSE',
      progressMs: 0,
      progressUpdatedAt: now,
      playlist: [songId],
      clientSeq: 1,
      version: 1,
      lastHeartbeatAt: null,
      invitationUrl:
        `https://st.music.163.com/listen-together/share/` +
        `?songId=${encodeURIComponent(songId)}` +
        `&roomId=${encodeURIComponent(roomId)}` +
        `&inviterId=${encodeURIComponent(account.userId)}`,
    };

    const warnings = [];
    try {
      await this.replacePlaylist([songId]);
    } catch (error) {
      warnings.push(`Initial playlist sync failed: ${error.message}`);
    }
    try {
      await this.control({ action: 'GOTO', songId, progressMs: 0 });
    } catch (error) {
      warnings.push(`Initial track command failed: ${error.message}`);
    }
    this.startHeartbeatLoop();
    await this.sendHeartbeat();
    await this.history?.start(this.snapshot());
    return { ...this.snapshot(), warnings };
  }

  async replacePlaylist(songIds) {
    this.requireSession();
    const normalized = [...new Set(songIds.map(String).filter(Boolean))];
    if (normalized.length === 0 || normalized.length > 200) {
      throw new Error('songIds must contain between 1 and 200 song IDs.');
    }
    const version = ++this.session.version;
    await this.client.replaceRoomPlaylist({
      roomId: this.session.roomId,
      userId: this.session.userId,
      version,
      songIds: normalized,
    });
    this.session.playlist = normalized;
    if (!normalized.includes(this.session.songId)) {
      this.session.formerSongId = this.session.songId;
      this.session.songId = normalized[0];
      this.session.progressMs = 0;
      this.session.progressUpdatedAt = this.clock();
    }
    return this.snapshot();
  }

  async startFromPlaylist(playlistId) {
    if (this.session) {
      throw new Error('A Listen Together room is already active. Close it first.');
    }
    const playlist = await this.client.getPlaylistTracks(playlistId);
    const songIds = playlist.songIds.slice(0, 200);
    if (songIds.length === 0) throw new Error('This playlist has no songs.');
    const session = await this.create(songIds[0]);
    await this.replacePlaylist(songIds);
    return { ...this.snapshot(), playlistName: playlist.name, warnings: session.warnings };
  }

  async control({ action, songId, progressMs }) {
    this.requireSession();
    const normalizedAction = String(action).toUpperCase();
    if (!VALID_ACTIONS.has(normalizedAction)) {
      throw new Error(`Unsupported playback action: ${action}`);
    }

    const previousSongId = this.session.songId;
    const targetSongId = String(songId ?? this.session.songId);
    const progress = Number.isFinite(progressMs)
      ? Math.max(0, Math.floor(progressMs))
      : this.currentProgress();
    const commandType = normalizedAction === 'SEEK' ? 'seek' : normalizedAction;
    const playStatus =
      normalizedAction === 'PAUSE'
        ? 'PAUSE'
        : normalizedAction === 'PLAY' || normalizedAction === 'SEEK'
          ? 'PLAY'
          : this.session.playStatus;
    const clientSeq = ++this.session.clientSeq;

    await this.client.sendPlayCommand({
      roomId: this.session.roomId,
      commandType,
      progress,
      playStatus,
      formerSongId: previousSongId ?? -1,
      targetSongId,
      clientSeq,
    });

    this.session.formerSongId = previousSongId;
    this.session.songId = targetSongId;
    this.session.playStatus = playStatus;
    this.session.progressMs = progress;
    this.session.progressUpdatedAt = this.clock();
    await this.sendHeartbeat();
    await this.history?.record(this.session.roomId, 'playback', this.snapshot());
    return this.snapshot();
  }

  async remoteStatus() {
    this.requireSession();
    const [room, playlist] = await Promise.all([
      this.client.checkRoom(this.session.roomId),
      this.client.getRoomPlaylist(this.session.roomId),
    ]);
    const status = { local: this.snapshot(), room, playlist };
    await this.history?.record(this.session.roomId, 'remote-status', status);
    return status;
  }

  async sendHeartbeat() {
    if (!this.session || this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      try {
        const remote = await this.client.getListenTogetherStatus();
        const playback = extractPlaybackState(remote);
        if (playback.songId && playback.songId !== this.session.songId) {
          this.session.formerSongId = this.session.songId;
          this.session.songId = playback.songId;
          this.session.progressMs = playback.progressMs ?? 0;
          this.session.progressUpdatedAt = this.clock();
          if (playback.playStatus) this.session.playStatus = playback.playStatus;
          await this.history?.record(this.session.roomId, 'remote-playback', this.snapshot());
        }
      } catch {
        // Some accounts or API versions do not expose status; heartbeat still works.
      }
      await this.client.heartbeat({
        roomId: this.session.roomId,
        songId: this.session.songId,
        playStatus: this.session.playStatus,
        progress: this.currentProgress(),
      });
      this.session.lastHeartbeatAt = new Date(this.clock()).toISOString();
      this.lastHeartbeatError = null;
      await this.history?.record(this.session.roomId, 'heartbeat', this.snapshot());
    } catch (error) {
      this.lastHeartbeatError = error.message;
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  startHeartbeatLoop() {
    this.stopHeartbeatLoop();
    this.timer = setInterval(() => void this.sendHeartbeat(), this.heartbeatMs);
    this.timer.unref?.();
  }

  stopHeartbeatLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async close() {
    this.requireSession();
    const roomId = this.session.roomId;
    this.stopHeartbeatLoop();
    try {
      const result = await this.client.endRoom(roomId);
      await this.history?.finish(roomId, { result });
      this.session = null;
      this.lastHeartbeatError = null;
      return { closed: true, roomId, result };
    } catch (error) {
      this.startHeartbeatLoop();
      throw error;
    }
  }

  requireSession() {
    if (!this.session) throw new Error('No active Listen Together room.');
  }
}

function extractPlaybackState(body) {
  const roots = [body?.data, body].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    candidates.push(
      root?.playInfo,
      root?.playback,
      root?.current,
      root?.roomInfo?.playInfo,
      root?.roomInfo,
      root,
    );
  }
  for (const value of candidates) {
    const songId = value?.songId ?? value?.currentSongId ?? value?.targetSongId;
    if (!songId || String(songId) === '-1') continue;
    return {
      songId: String(songId),
      playStatus: value?.playStatus ?? value?.status ?? null,
      progressMs: Number.isFinite(Number(value?.progress)) ? Number(value.progress) : null,
    };
  }
  return {};
}
