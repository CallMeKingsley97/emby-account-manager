[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CallMeKingsley97/emby-account-manager)

# Emby 账号管理器

部署在 Cloudflare Workers（免费版即可）上的 Emby 多账号管理面板。数据存 KV，无需自有服务器。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CallMeKingsley97/emby-account-manager)

## 功能

- 导入多个 Emby 账号，每个账号一张卡片（名称 / 备注 / 最近观看时间与观看的内容名）
- 点击卡片查看详情：电影 / 剧集 / 集数 / 歌曲 / 专辑 / 图书数量
- 每个账号支持**多条线路**（主线路 + 备用线路），字段与常见订阅 App 一致：
  线路名称、主机、端口、路径、https 开关、用户名、密码
- 保存时逐条线路尝试登录，可用的作为主线路；刷新时自动切换到第一条可用线路
- 详情页可单独测试每条线路的连通性
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

## 注意

- Emby 服务器必须公网可达（Workers 从 Cloudflare 边缘发起请求，访问不了家庭内网地址，除非有公网 IP / 内网穿透）
- KV 免费额度每天 10 万次读 / 1000 次写，个人使用完全够用
- Emby 密码默认明文存 KV；配置 `ENCRYPT_KEY` 后改用 **AES-256-GCM 加密存储**（PBKDF2 派生密钥，每条密码独立随机 IV）。注意：密钥同样放在 Workers 配置里，这只防"直接翻看 KV"的场景，不能防拥有 Worker 配置权限的人；API 返回给前端时一律隐藏密码字段。面板密码（`ACCESS_PASSWORD`）同理只是轻量防护。
