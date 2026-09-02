import { createServer } from 'node:http';
import { NeteaseClient } from './netease.js';
import { ListenTogetherSessionManager } from './session-manager.js';

const host = '127.0.0.1';
const port = Number(process.env.PANEL_PORT ?? 3457);
const client = new NeteaseClient({ cookie: process.env.NETEASE_COOKIE });
const manager = new ListenTogetherSessionManager({
  client,
  heartbeatMs: Number(process.env.HEARTBEAT_MS ?? 15_000),
});

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>网易云一起听 · 本地控制台</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, "Microsoft YaHei", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111; color: #f5f5f5; }
    main { box-sizing: border-box; width: min(600px, calc(100% - 32px)); padding: 30px; border: 1px solid #2e2e2e; border-radius: 18px; background: #181818; box-shadow: 0 16px 60px #0008; }
    h1 { margin: 0 0 8px; font-size: 24px; } p { color: #bbb; line-height: 1.6; }
    input { box-sizing: border-box; width: 100%; padding: 12px; border: 1px solid #444; border-radius: 10px; background: #111; color: inherit; font-size: 15px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; } button { border: 0; border-radius: 10px; padding: 11px 15px; cursor: pointer; font: inherit; font-weight: 650; background: #e8183f; color: white; } button.secondary { background: #333; } button.danger { background: #7e2335; } button:disabled { opacity: .45; cursor: wait; }
    #card { margin-top: 20px; padding: 16px; border-radius: 12px; background: #101010; border: 1px solid #303030; } a { color: #ff6b85; overflow-wrap: anywhere; } pre { white-space: pre-wrap; word-break: break-word; color: #b7d7ff; font-size: 12px; } .ok { color: #7de3a0; } .off { color: #aaa; }
  </style>
</head>
<body><main>
  <h1>网易云一起听</h1>
  <p>这个页面只在你的电脑本机开放。创建房间后，把邀请链接发给自己的 iPhone 主号打开即可。</p>
  <input id="song" value="2676664123" inputmode="numeric" placeholder="网易云歌曲 ID">
  <div class="row">
    <button id="create">创建房间</button>
    <button id="copy" class="secondary" disabled>复制邀请链接</button>
    <button id="close" class="danger" disabled>关闭房间</button>
  </div>
  <section id="card"><span class="off">还没有活动房间</span></section>
  <p>测试用默认歌曲是《Ditto》的混音版。房间开启时请保持这个窗口和 PowerShell 都不要关闭。</p>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  let session = null;
  const show = (data) => {
    session = data.active ? data : null;
    $('copy').disabled = !session?.invitationUrl;
    $('close').disabled = !session;
    $('create').disabled = Boolean(session);
    $('card').innerHTML = session
      ? '<div class="ok">房间正在维持心跳</div><p>房间号：' + session.roomId + '</p><p>当前歌曲 ID：' + session.songId + '</p><p><a target="_blank" rel="noreferrer" href="' + session.invitationUrl + '">打开邀请链接</a></p><pre>' + JSON.stringify({playStatus: session.playStatus, heartbeat: session.lastHeartbeatAt || '刚创建'}, null, 2) + '</pre>'
      : '<span class="off">还没有活动房间</span>';
  };
  async function request(path, body) {
    const response = await fetch(path, {method: body ? 'POST' : 'GET', headers: {'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '请求失败');
    return result;
  }
  $('create').onclick = async () => {
    const songId = $('song').value.trim();
    if (!songId) return alert('请输入网易云歌曲 ID');
    $('create').disabled = true;
    try { show(await request('/api/create', {songId})); } catch (e) { alert(e.message); $('create').disabled = false; }
  };
  $('copy').onclick = async () => { await navigator.clipboard.writeText(session.invitationUrl); $('copy').textContent = '已复制'; setTimeout(() => $('copy').textContent = '复制邀请链接', 1200); };
  $('close').onclick = async () => { if (!confirm('要结束这间一起听房间吗？')) return; try { const r = await request('/api/close', {}); show(r.session); } catch (e) { alert(e.message); } };
  request('/api/session').then(show).catch((e) => $('card').textContent = e.message);
  setInterval(() => request('/api/session').then(show).catch(() => {}), 8000);
</script></body></html>`;

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${host}:${port}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
      res.end(page);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/session') return sendJson(res, 200, manager.snapshot());
    if (req.method === 'POST' && url.pathname === '/api/create') {
      const { songId } = await readJson(req);
      if (!/^\d+$/.test(String(songId ?? ''))) return sendJson(res, 400, {error: '歌曲 ID 应为纯数字'});
      return sendJson(res, 200, await manager.create(String(songId)));
    }
    if (req.method === 'POST' && url.pathname === '/api/close') {
      const result = manager.snapshot().active ? await manager.close() : {closed: false};
      return sendJson(res, 200, {result, session: manager.snapshot()});
    }
    sendJson(res, 404, {error: 'Not found'});
  } catch (error) {
    sendJson(res, 500, {error: error instanceof Error ? error.message : String(error)});
  }
});

server.listen(port, host, () => console.log(`本地控制台已打开：http://${host}:${port}`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
