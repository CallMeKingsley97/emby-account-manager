
# Emby 账号管理器

部署在 Cloudflare Workers（免费版即可）上的 Emby 多账号管理面板。数据存 KV，无需自有服务器。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CallMeKingsley97/emby-account-manager)

## 功能

- 导入多个 Emby 账号，每个账号一张卡片（名称 / 备注 / 最近观看时间与观看的内容名）
- 列表可按最近观看、电影、剧集、集数、歌曲、专辑、图书、名称排序（正序/倒序，本地记住选择；无数据的账号始终排最后）
- 点击卡片查看详情：电影 / 剧集 / 集数 / 歌曲 / 专辑 / 图书数量
- 每个账号支持**多条线路**（主线路 + 备用线路），字段与常见订阅 App 一致：
  线路名称、主机、端口、路径、https 开关、用户名、密码
- 保存时逐条线路尝试登录，可用的作为主线路；刷新时自动切换到第一条可用线路
- 详情页可单独测试每条线路的连通性
- **账号状态**：卡片显示"登录失败"、"已禁用"、"N 天未观看"（天数在设置中调整，默认 30），多个账户属于同一台服务器（相同 ServerId）时显示"同服"
- **线路测速**：手动刷新时并行探测所有线路，用延迟最低的可用线路（延迟从 Cloudflare 节点测得，不改动你设置的主线路顺序）
- **详情页实时内容**：在线会话（排查合租账号被他人使用）、继续观看、下一集、最近入库、收藏、媒体库列表。默认手动加载，结果缓存 5 分钟
- **定时巡检 + 通知**：默认每个账号每天检查一次，频率按天在面板「设置」中调整，也可点按钮立即巡检；状态变化（失效 / 恢复 / 被禁用）时推送到 Telegram 或 Bark
- Emby 密码可选 AES-256-GCM 加密存储（配置 `ENCRYPT_KEY`）
- 可选的访问密码保护（`ACCESS_PASSWORD`）
- **一键导入到播放器**：详情页可生成带凭据的深链，一键唤起 App 完成服务器导入
  - 支持：SenPlayer、VidHub、Rex、Hills、Forward、OopsPlayer、EplayerX、小幻影视、Libra
    （多线路随链接一并导入；Hills/Rex/Forward/VidHub 的协议不含路径参数，带 path 的主线路会提示手动补充）
  - Infuse / Fileball / AfuseKt / Yamby 暂不支持链接导入（仅提供"复制服务器信息"手动添加）

## 一键部署

点击上面的 **Deploy to Cloudflare** 按钮，Cloudflare 会自动：

1. 克隆仓库到你的 GitHub 账号（或选择已有仓库）
2. 创建 KV 命名空间并绑定
3. 部署 Worker

部署完成后：

1. 进入 Cloudflare 控制台 → 你的 Worker → **Settings → Variables and Secrets**
2. （推荐）添加变量 `ENCRYPT_KEY`，值为 `openssl rand -hex 32` 生成的随机串，启用密码加密存储
3. （可选）添加变量 `ACCESS_PASSWORD`，给面板加一道访问密码
4. （可选）配置巡检通知：`TG_BOT_TOKEN` + `TG_CHAT_ID`，或 `BARK_URL`（如 `https://api.day.app/<key>`），然后在面板「设置」里点「发送测试通知」验证

### 请求频率说明

面板不会在后台频繁访问 Emby 服务器，所有自动行为都在「设置」中控制：

| 行为 | 何时访问 Emby | 控制方式 |
|---|---|---|
| 打开页面 / 账户列表 | 不访问（只读 KV） | — |
| 自动巡检 | 每个账号按天检查一次（可选每 1 / 2 / 3 / 5 / 7 / 14 / 30 天）；账号多时分摊到不同小时，每次最多 1~5 个（默认 3），每个约 3~5 个请求 | 默认**开启**，每天一次 |
| 立即巡检 | 在设置中点「立即巡检全部账户」时，逐个检查一遍 | 手动 |
| 详情页实时内容 | 点击加载时发 6 个请求，5 分钟内重复打开用缓存 | 默认手动，可开自动加载 |
| 刷新 / 测试线路 / 保存 | 仅手动点击时 | — |

- 手动刷新也算一次检查，会推迟该账号的下次自动巡检
- 巡检优先复用缓存的 token，失效才重新登录，不会在 Emby 后台留下大量登录记录
- 只在状态**变化**时推送，不会每次巡检都重复提醒

## 手动部署

```bash
npm install -g wrangler
wrangler login

# 创建 KV 命名空间，把输出的 id 填进 wrangler.toml
wrangler kv namespace create KV

# 推荐：生成密码加密密钥，填入 wrangler.toml 的 ENCRYPT_KEY
openssl rand -hex 32

# 可选：在 wrangler.toml 中设置 ACCESS_PASSWORD

wrangler deploy
```

本地开发：`wrangler dev`

## Emby API 说明

- 登录：`POST /emby/Users/AuthenticateByName`，取 `AccessToken` 与 `User.Id`
- 资源数量：`GET /emby/Items/Counts`（电影、剧集、集数、音乐等总数）
- 最近观看：`GET /emby/Users/{userId}/PlayedItems/Latest`，后备
  `GET /emby/Items?SortBy=DatePlayed&Filters=IsPlayed`，取 `UserData.LastPlayedDate`
- 账号状态：`GET /emby/Users/{userId}`，取 `Policy.IsDisabled`（同时用来校验缓存 token 是否有效）
- 服务器信息 / 测速：`GET /emby/System/Info/Public`（无需登录），取 `ServerName`、`Version`、`Id`
- 详情页实时内容：`/Users/{id}/Views`、`/Users/{id}/Items/Resume`、`/Shows/NextUp`、`/Users/{id}/Items/Latest`、
  `/Users/{id}/Items?Filters=IsFavorite`、`/Sessions`（按当前用户过滤）

## 注意

- Emby 服务器必须公网可达（Workers 从 Cloudflare 边缘发起请求，访问不了家庭内网地址，除非有公网 IP / 内网穿透）
- KV 免费额度每天 10 万次读 / 1000 次写，个人使用完全够用
- Emby 密码默认明文存 KV；配置 `ENCRYPT_KEY` 后改用 **AES-256-GCM 加密存储**（PBKDF2 派生密钥，每条密码独立随机 IV）。注意：密钥同样放在 Workers 配置里，这只防"直接翻看 KV"的场景，不能防拥有 Worker 配置权限的人；API 返回给前端时一律隐藏密码字段。面板密码（`ACCESS_PASSWORD`）同理只是轻量防护。
