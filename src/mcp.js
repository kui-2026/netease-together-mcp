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
    version: '0.1.0',
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
