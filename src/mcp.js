import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const textResult = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const guarded = (handler) => async (args) => {
  try {
    return textResult(await handler(args));
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: error.message,
            detail: error.detail,
          }),
        },
      ],
      isError: true,
    };
  }
};

const requireConfirmation = (confirmed) => {
  if (confirmed !== true) {
    throw new Error('This action changes the NetEase account or room. Ask the user and pass confirm=true.');
  }
};

export function createMcpServer(manager, client) {
  const server = new McpServer({
    name: 'netease-together-mcp',
    version: '0.1.1',
  });

  server.registerTool(
    'netease_account_status',
    {
      title: 'Check NetEase account',
      description: 'Verify the configured NetEase small-account cookie and return only public profile information.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(() => client.accountInfo()),
  );

  server.registerTool(
    'search_netease_songs',
    {
      title: 'Search NetEase songs',
      description: 'Search NetEase Cloud Music and return song IDs, artists, albums, and durations.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(({ query, limit }) => client.searchSongs(query, limit)),
  );

  server.registerTool(
    'get_netease_user_profile',
    {
      title: 'Read a NetEase user profile',
      description: 'Read profile details, public playlists, and listening rankings visible to the configured account. Use user ID 1461039775 for the owner\'s main account.',
      inputSchema: { user_id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(({ user_id }) => client.getUserProfile(user_id)),
  );

  server.registerTool(
    'get_netease_song_details',
    {
      title: 'Resolve NetEase song IDs',
      description: 'Resolve up to 200 NetEase song IDs to names, artists, albums, durations, and cover URLs.',
      inputSchema: { song_ids: z.array(z.string().min(1)).min(1).max(200) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(({ song_ids }) => client.getSongDetails(song_ids)),
  );

  server.registerTool(
    'list_listen_together_history',
    {
      title: 'List Listen Together history',
      description: 'Return durable history captured for rooms created and monitored by this MCP, including songs and room observations.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ limit }) => {
      const sessions = await (manager.history?.list(limit) ?? []);
      const songIds = [...new Set(sessions.flatMap((session) => session.songs.map((song) => song.id)))];
      const details = songIds.length ? await client.getSongDetails(songIds) : [];
      const byId = Object.fromEntries(details.map((song) => [song.id, song]));
      return sessions.map((session) => ({
        ...session,
        songs: session.songs.map((song) => ({ ...song, ...byId[song.id] })),
        events: session.events.map((event) => ({
          ...event,
          song: event.songId ? byId[event.songId] : undefined,
          oldSong: event.oldSongId ? byId[event.oldSongId] : undefined,
          newSong: event.newSongId ? byId[event.newSongId] : undefined,
        })),
      }));
    }),
  );

  server.registerTool(
    'save_listen_together_memory',
    {
      title: 'Save a Listen Together memory',
      description: 'Attach a user-approved title and note to the latest or selected durable Listen Together history entry.',
      inputSchema: {
        room_id: z.string().min(1).optional(),
        title: z.string().max(120).optional(),
        note: z.string().max(2000).optional(),
        confirm: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(({ room_id, title, note, confirm }) => {
      requireConfirmation(confirm);
      return manager.history.saveMemory({ roomId: room_id, title, note });
    }),
  );

  server.registerTool(
    'list_small_account_playlists',
    {
      title: 'List small-account playlists',
      description: 'List playlists owned or collected by the configured NetEase small account.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(() => client.listMyPlaylists()),
  );

  server.registerTool(
    'get_netease_playlist_tracks',
    {
      title: 'Read playlist tracks',
      description: 'Read a NetEase playlist and return its tracks and song IDs.',
      inputSchema: { playlist_id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(({ playlist_id }) => client.getPlaylistTracks(playlist_id)),
  );

  server.registerTool(
    'create_small_account_playlist',
    {
      title: 'Create small-account playlist',
      description: 'Create a new playlist under the NetEase small account. Private is recommended for shared AI-curated playlists.',
      inputSchema: {
        name: z.string().min(1).max(80),
        privacy: z.enum(['private', 'public']).default('private'),
        confirm: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(({ name, privacy, confirm }) => {
      requireConfirmation(confirm);
      return client.createPlaylist(name, privacy === 'private' ? 10 : 0);
    }),
  );

  for (const [toolName, title, operation] of [
    ['add_tracks_to_small_account_playlist', 'Add tracks to playlist', 'add'],
    ['remove_tracks_from_small_account_playlist', 'Remove tracks from playlist', 'del'],
  ]) {
    server.registerTool(
      toolName,
      {
        title,
        description: `${title} on the NetEase small account.`,
        inputSchema: {
          playlist_id: z.string().min(1),
          song_ids: z.array(z.string().min(1)).min(1).max(200),
          confirm: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: operation === 'del', idempotentHint: operation === 'add', openWorldHint: true },
      },
      guarded(({ playlist_id, song_ids, confirm }) => {
        requireConfirmation(confirm);
        return client.updatePlaylistTracks({ playlistId: playlist_id, songIds: song_ids, operation });
      }),
    );
  }

  server.registerTool(
    'create_listen_together_room',
    {
      title: 'Create Listen Together room',
      description: 'Create an official NetEase Listen Together room, start its heartbeat, and return an invitation URL for the user to open on iPhone.',
      inputSchema: {
        initial_song_id: z.string().min(1).describe('NetEase song ID used as the first track'),
        confirm: z.boolean().describe('Must be true after the user confirms room creation'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(({ initial_song_id, confirm }) => {
      requireConfirmation(confirm);
      return manager.create(initial_song_id);
    }),
  );

  server.registerTool(
    'create_listen_together_from_playlist',
    {
      title: 'Start Listen Together from playlist',
      description: 'Create an official Listen Together room and synchronize up to 200 tracks from a NetEase playlist.',
      inputSchema: {
        playlist_id: z.string().min(1),
        confirm: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(({ playlist_id, confirm }) => {
      requireConfirmation(confirm);
      return manager.startFromPlaylist(playlist_id);
    }),
  );

  server.registerTool(
    'send_listen_together_invitation',
    {
      title: 'Send Listen Together invitation',
      description: 'Send the active official Listen Together room invitation URL as a NetEase private message to one specified user. This sends a real message from the configured small account and requires confirm=true.',
      inputSchema: {
        recipient_user_id: z.string().min(1).describe('NetEase user ID that should receive the invitation'),
        message: z.string().min(1).max(700).optional().describe('Optional text placed before the invitation URL'),
        confirm: z.boolean().describe('Must be true after the user confirms sending the private message'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async ({ recipient_user_id, message, confirm }) => {
      requireConfirmation(confirm);
      const session = manager.snapshot();
      if (!session.active) throw new Error('No active Listen Together room. Create one before sending an invitation.');
      const invitationMessage = [message?.trim(), session.invitationUrl]
        .filter(Boolean)
        .join('\n');
      const delivery = await client.sendPrivateMessage({
        userId: recipient_user_id,
        message: invitationMessage,
      });
      await manager.history?.record(session.roomId, 'invitation-sent', {
        recipientUserId: String(recipient_user_id),
        invitationUrl: session.invitationUrl,
      });
      return {
        sent: true,
        roomId: session.roomId,
        recipientUserId: String(recipient_user_id),
        invitationUrl: session.invitationUrl,
        deliveryMethod: delivery.method,
      };
    }),
  );

  server.registerTool(
    'get_listen_together_session',
    {
      title: 'Get local room session',
      description: 'Return the locally maintained room, current track, playback state, invitation URL, and heartbeat health.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(() => manager.snapshot()),
  );

  server.registerTool(
    'check_listen_together_room',
    {
      title: 'Check official room state',
      description: 'Fetch the current room and synchronized playlist state from NetEase.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(() => manager.remoteStatus()),
  );

  server.registerTool(
    'replace_listen_together_playlist',
    {
      title: 'Replace room playlist',
      description: 'Replace the official Listen Together room playlist with NetEase song IDs.',
      inputSchema: {
        song_ids: z.array(z.string().min(1)).min(1).max(200),
        confirm: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded(({ song_ids, confirm }) => {
      requireConfirmation(confirm);
      return manager.replacePlaylist(song_ids);
    }),
  );

  server.registerTool(
    'control_listen_together_playback',
    {
      title: 'Control room playback',
      description: 'Send an official GOTO, PLAY, PAUSE, or SEEK command to the active room.',
      inputSchema: {
        action: z.enum(['GOTO', 'PLAY', 'PAUSE', 'SEEK']),
        song_id: z.string().min(1).optional(),
        progress_ms: z.number().int().min(0).optional(),
        confirm: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(({ action, song_id, progress_ms, confirm }) => {
      requireConfirmation(confirm);
      return manager.control({ action, songId: song_id, progressMs: progress_ms });
    }),
  );

  server.registerTool(
    'close_listen_together_room',
    {
      title: 'Close Listen Together room',
      description: 'End the active official NetEase Listen Together room and stop its heartbeat.',
      inputSchema: { confirm: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guarded(({ confirm }) => {
      requireConfirmation(confirm);
      return manager.close();
    }),
  );

  return server;
}
