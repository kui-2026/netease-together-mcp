# NetEase Together MCP (POC)

一个轻量的网易云音乐“一起听”远程 MCP 验证工程。它使用单独的网易云小号创建官方一起听房间，生成邀请链接，并在后台维持心跳、同步歌单和发送播放指令。

> 当前状态：代码与模拟测试版。网易云接口属于非公开接口，首次使用必须用小号进行实机验证，不能承诺长期稳定。

## 能做什么

- 检查小号登录状态
- 搜歌、查看小号歌单、读取歌单歌曲
- 创建私密或公开歌单，向其中添加或移除歌曲
- 创建官方“一起听”房间并生成 iPhone 可点击的邀请链接
- 后台维持房间心跳
- 替换房间歌单，或直接从小号歌单创建房间
- 播放、暂停、跳转歌曲、调整进度
- 查看房间与歌单状态
- 结束房间

目前不会在网易云站内主动私信主号；邀请链接由 ChatGPT 返回，用户点击后用网易云 App 加入。

## 安全原则

- 只用无重要资产的小号。
- 不要把密码或 Cookie 发进聊天、Issue、GitHub 仓库。
- `.env` 已被 Git 忽略，Cookie 仅通过运行环境注入。
- 云端启动必须设置 `MCP_AUTH_TOKEN`。
- `compose.yaml` 默认只监听服务器本机的 `127.0.0.1:3456`，应再通过带 HTTPS 的反向代理或安全隧道发布。
- 所有创建房间、控制播放和改歌单工具都要求 `confirm=true`。

## 本地首次验证（Windows）

需要安装 Node.js 20 或更高版本。PowerShell 中进入项目目录后：

```powershell
Copy-Item .env.example .env
npm install --ignore-scripts
npm test
$env:HOST="127.0.0.1"
$env:ALLOW_INSECURE_LOCAL="true"
$env:NETEASE_COOKIE="从你自己的浏览器本地复制，勿发给别人"
npm start
```

健康检查地址：`http://127.0.0.1:3456/health`；MCP 地址：`http://127.0.0.1:3456/mcp`。

第一次测试只需验证：账户状态 → 创建房间 → iPhone 点击邀请链接 → 加入 → 播放/暂停 → 保持十分钟 → 结束房间。

### 不敲命令的本地控制台

如果只是本机创建和关闭房间，运行：

```powershell
npm.cmd run panel
```

随后浏览器访问 `http://127.0.0.1:3457`。页面会显示邀请链接，并提供“创建房间”和“关闭房间”按钮。这个页面只监听本机，不能在公网访问。

## Docker 部署

生成随机令牌并写入 `.env`，随后：

```bash
docker compose up -d --build
```

不要把 3456 端口直接暴露到公网。正式远程接入前，需要配置 HTTPS 反向代理或受保护的隧道。

## MCP 工具

- `netease_account_status`
- `search_netease_songs`
- `list_small_account_playlists`
- `get_netease_playlist_tracks`
- `create_small_account_playlist`
- `add_tracks_to_small_account_playlist`
- `remove_tracks_from_small_account_playlist`
- `create_listen_together_room`
- `create_listen_together_from_playlist`
- `get_listen_together_session`
- `check_listen_together_room`
- `replace_listen_together_playlist`
- `control_listen_together_playback`
- `close_listen_together_room`

## 技术来源

本 POC 的整体思路参考 [Vael-KY/netease-music-mcp](https://github.com/Vael-KY/netease-music-mcp)，一起听接口通过 MIT 许可的 [NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) 包调用。本项目本身不包含网易云账号凭据。

## 已知限制

- 私有接口可能随网易云更新而失效。
- 云服务器 IP 与常用登录地区差异过大时，Cookie 可能失效或触发风控。
- 后台服务负责技术上的心跳和控制；模型不会持续接收或听见音频。
- ChatGPT 手机端能否直接显示自建 MCP，需要在同一账号完成远程连接后实机验证。
