import 'dotenv/config';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { NeteaseClient } from './netease.js';
import { ListenTogetherSessionManager } from './session-manager.js';
import { createMcpServer } from './mcp.js';

const port = Number(process.env.PORT ?? 3456);
const host = process.env.HOST ?? '0.0.0.0';
const authToken = process.env.MCP_AUTH_TOKEN?.trim() ?? '';
const allowInsecureLocal = process.env.ALLOW_INSECURE_LOCAL === 'true';

if (!authToken && !(allowInsecureLocal && ['127.0.0.1', 'localhost'].includes(host))) {
  throw new Error(
    'MCP_AUTH_TOKEN is required. For local-only testing, set HOST=127.0.0.1 and ALLOW_INSECURE_LOCAL=true.',
  );
}

const client = new NeteaseClient({ cookie: process.env.NETEASE_COOKIE });
const manager = new ListenTogetherSessionManager({
  client,
  heartbeatMs: Number(process.env.HEARTBEAT_MS ?? 15_000),
});
const app = createMcpExpressApp({ host });

function tokenMatches(candidate) {
  if (!authToken || !candidate) return false;
  const expected = Buffer.from(authToken);
  const supplied = Buffer.from(candidate);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function authorize(req, res, next) {
  if (!authToken && allowInsecureLocal) return next();
  const header = req.get('authorization') ?? '';
  const candidate = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!tokenMatches(candidate)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0', roomActive: manager.snapshot().active });
});

app.use('/mcp', authorize);

app.post('/mcp', async (req, res) => {
  const server = createMcpServer(manager, client);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error instanceof Error ? error.message : error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  } finally {
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
  }
});

app.get('/mcp', authorize, (_req, res) => {
  res.status(405).json({ error: 'Use POST /mcp' });
});
app.delete('/mcp', authorize, (_req, res) => {
  res.status(405).json({ error: 'Stateless transport does not support DELETE' });
});

const httpServer = createServer(app);
httpServer.listen(port, host, () => {
  console.log(`NetEase Together MCP listening on http://${host}:${port}/mcp`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    manager.stopHeartbeatLoop();
    httpServer.close(() => process.exit(0));
  });
}
