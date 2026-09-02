import apiModule from '@neteasecloudmusicapienhanced/api';

const defaultApi = apiModule?.default ?? apiModule;

export class NeteaseApiError extends Error {
  constructor(message, detail = undefined) {
    super(message);
    this.name = 'NeteaseApiError';
    this.detail = detail;
  }
}

export class NeteaseClient {
  constructor({ cookie, api = defaultApi } = {}) {
    this.cookie = cookie?.trim() ?? '';
    this.api = api;
  }

  ensureConfigured() {
    if (!this.cookie) {
      throw new NeteaseApiError(
        'NETEASE_COOKIE is not configured. Set it privately in the server environment; never paste it into chat.',
      );
    }
  }

  async call(method, params = {}) {
    this.ensureConfigured();
    const fn = this.api[method];
    if (typeof fn !== 'function') {
      throw new NeteaseApiError(`Unsupported NetEase API method: ${method}`);
    }

    let raw;
    try {
      raw = await fn({ ...params, cookie: this.cookie });
    } catch (error) {
      throw new NeteaseApiError(`NetEase request failed: ${method}`, {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const body = raw?.body ?? raw;
    const code = body?.code ?? body?.data?.code;
    if (typeof code === 'number' && code !== 200) {
      throw new NeteaseApiError(
        body?.message || body?.msg || `NetEase returned code ${code}`,
        { method, code },
      );
    }
    return body;
  }

  async accountInfo() {
    const body = await this.call('login_status', { timestamp: Date.now() });
    const profile = body?.data?.profile ?? body?.profile;
    if (!profile?.userId) {
      throw new NeteaseApiError('The NetEase cookie is invalid or expired.');
    }
    return {
      userId: String(profile.userId),
      nickname: profile.nickname ?? 'unknown',
    };
  }

  async searchSongs(query, limit = 10) {
    const body = await this.call('search', {
      keywords: query,
      limit: Math.max(1, Math.min(Number(limit) || 10, 20)),
    });
    return (body?.result?.songs ?? []).map((song) => ({
      id: String(song.id),
      name: song.name,
      artists: (song.artists ?? song.ar ?? []).map((artist) => artist.name).join(', '),
      album: song.album?.name ?? song.al?.name ?? null,
      durationMs: song.duration ?? song.dt ?? null,
    }));
  }

  async listMyPlaylists(limit = 100) {
    const account = await this.accountInfo();
    const body = await this.call('user_playlist', {
      uid: account.userId,
      limit: Math.max(1, Math.min(Number(limit) || 100, 100)),
    });
    return (body?.playlist ?? []).map((playlist) => ({
      id: String(playlist.id),
      name: playlist.name,
      trackCount: playlist.trackCount ?? 0,
      description: playlist.description ?? null,
      mine: String(playlist.creator?.userId ?? '') === account.userId,
    }));
  }

  async getUserProfile(userId) {
    const uid = String(userId);
    const [detail, playlists, weeklyRecord, allRecord] = await Promise.all([
      this.call('user_detail', { uid }),
      this.call('user_playlist', { uid, limit: 100 }),
      this.call('user_record', { uid, type: 1 }).catch((error) => ({ unavailable: error.message })),
      this.call('user_record', { uid, type: 0 }).catch((error) => ({ unavailable: error.message })),
    ]);
    const profile = detail?.profile ?? {};
    const normalizeRecord = (body) => ({
      unavailable: body?.unavailable,
      songs: (body?.weekData ?? body?.allData ?? []).slice(0, 100).map((item) => ({
        id: String(item.song?.id ?? ''),
        name: item.song?.name ?? null,
        artists: (item.song?.ar ?? item.song?.artists ?? []).map((artist) => artist.name).join(', '),
        playCount: item.playCount ?? null,
        score: item.score ?? null,
      })),
    });
    return {
      userId: uid,
      nickname: profile.nickname ?? null,
      avatarUrl: profile.avatarUrl ?? null,
      signature: profile.signature ?? null,
      level: detail?.level ?? null,
      follows: profile.follows ?? null,
      followeds: profile.followeds ?? null,
      eventCount: profile.eventCount ?? null,
      playlistCount: profile.playlistCount ?? null,
      listenSongs: profile.listenSongs ?? null,
      playlists: (playlists?.playlist ?? []).map((playlist) => ({
        id: String(playlist.id), name: playlist.name, trackCount: playlist.trackCount ?? 0,
        public: playlist.privacy === 0, subscribed: Boolean(playlist.subscribed),
      })),
      weeklyListening: normalizeRecord(weeklyRecord),
      allTimeListening: normalizeRecord(allRecord),
    };
  }

  async getPlaylistTracks(playlistId) {
    const body = await this.call('playlist_detail', { id: String(playlistId) });
    const playlist = body?.playlist ?? {};
    const tracks = playlist.tracks ?? [];
    const ids = playlist.trackIds?.map((track) => String(track.id)) ?? tracks.map((track) => String(track.id));
    return {
      id: String(playlist.id ?? playlistId),
      name: playlist.name ?? 'unknown',
      trackCount: playlist.trackCount ?? ids.length,
      songIds: ids,
      tracks: tracks.map((song) => ({
        id: String(song.id),
        name: song.name,
        artists: (song.ar ?? song.artists ?? []).map((artist) => artist.name).join(', '),
      })),
    };
  }

  async createPlaylist(name, privacy = 10) {
    const body = await this.call('playlist_create', {
      name,
      privacy: String(privacy),
      type: 'NORMAL',
    });
    const playlist = body?.playlist ?? body?.data?.playlist ?? {};
    return { id: String(playlist.id ?? body?.id ?? ''), name: playlist.name ?? name, privacy: Number(privacy) };
  }

  updatePlaylistTracks({ playlistId, songIds, operation }) {
    if (!['add', 'del'].includes(operation)) throw new NeteaseApiError('operation must be add or del');
    return this.call('playlist_tracks', {
      pid: String(playlistId),
      tracks: songIds.map(String).join(','),
      op: operation,
    });
  }

  createRoom() {
    return this.call('listentogether_room_create');
  }

  checkRoom(roomId) {
    return this.call('listentogether_room_check', { roomId: String(roomId) });
  }

  getRoomPlaylist(roomId) {
    return this.call('listentogether_sync_playlist_get', {
      roomId: String(roomId),
    });
  }

  replaceRoomPlaylist({ roomId, userId, version, songIds }) {
    const csv = songIds.map(String).join(',');
    return this.call('listentogether_sync_list_command', {
      roomId: String(roomId),
      commandType: 'REPLACE',
      userId: String(userId),
      version: String(version),
      playMode: 'ORDER_LOOP',
      displayList: csv,
      randomList: csv,
    });
  }

  sendPlayCommand({
    roomId,
    commandType,
    progress,
    playStatus,
    formerSongId,
    targetSongId,
    clientSeq,
  }) {
    return this.call('listentogether_play_command', {
      roomId: String(roomId),
      commandType,
      progress: String(Math.max(0, Math.floor(progress))),
      playStatus,
      formerSongId: String(formerSongId ?? -1),
      targetSongId: String(targetSongId),
      clientSeq: String(clientSeq),
    });
  }

  heartbeat({ roomId, songId, playStatus, progress }) {
    return this.call('listentogether_heatbeat', {
      roomId: String(roomId),
      songId: String(songId),
      playStatus,
      progress: String(Math.max(0, Math.floor(progress))),
    });
  }

  endRoom(roomId) {
    return this.call('listentogether_end', { roomId: String(roomId) });
  }
}

export function extractRoomId(body) {
  const roomId =
    body?.data?.roomInfo?.roomId ??
    body?.roomInfo?.roomId ??
    body?.data?.roomId ??
    body?.roomId;
  if (!roomId) {
    throw new NeteaseApiError('Room creation succeeded but no roomId was returned.', {
      responseKeys: body && typeof body === 'object' ? Object.keys(body) : [],
    });
  }
  return String(roomId);
}
