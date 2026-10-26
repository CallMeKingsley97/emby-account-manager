/**
 * Emby 账号管理器 — Cloudflare Workers (KV 存储)
 *
 * 数据模型 (KV: key = "acct:<id>")：
 * {
 *   id, name, note,
 *   lines: [{ name, host, path, port, https, username, password }],  // 主线路为 lines[0]
 *   userId, token,          // 登录成功后缓存（主线路的）
 *   lastWatchedAt,          // 最近一次观看时间
 *   counts: { movie, series, episode, song, ... },
 *   updatedAt
 * }
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

function checkAuth(request, env) {
  const pwd = (env.ACCESS_PASSWORD || '').trim();
  if (!pwd) return true;
  const url = new URL(request.url);
  const token = url.searchParams.get('pwd') || request.headers.get('X-Panel-Password') || '';
  return token === pwd;
}

/** 把线路配置拼成 baseUrl（去除末尾斜杠） */
function buildBaseUrl(line) {
  let host = (line.host || '').trim();
  // 兼容粘贴完整 URL 的情况：host 里带了协议前缀则提取协议，避免拼出 https://https://...
  const m = host.match(/^(https?):\/\//i);
  let proto;
  if (m) {
    proto = m[1].toLowerCase();
    host = host.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  } else {
    // https 兼容布尔 / 字符串 / 数字几种存储形态
    proto = (line.https === true || line.https === 'true' || line.https === 1) ? 'https' : 'http';
  }
  let base = `${proto}://${host}`;
  if (line.port) base += `:${line.port}`;
  if (line.path) base += line.path.startsWith('/') ? line.path : '/' + line.path;
  return base.replace(/\/+$/, '');
}

/** 调用 Emby API，超时 12 秒；可通过 options.headers 覆盖身份 UA */
async function embyFetch(baseUrl, path, options = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { ...(options.headers || {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 登录身份列表：部分站点按客户端白名单放行（仅常见播放器可登录），
 * 会同时校验 UA 和 X-Emby-Authorization 的 Client 字段。
 * 依次尝试，命中一个即用该身份完成登录及后续 API 调用。
 */
const CLIENT_IDENTITIES = [
  { client: 'SenPlayer', device: 'iPhone', version: '1.5.4', ua: 'SenPlayer/1.5.4 (iPhone; iOS 18.0; Scale/3.00)' },
  { client: 'VidHub', device: 'iPhone', version: '1.4.8', ua: 'VidHub/1.4.8 (iPhone; iOS 18.0; Scale/3.00)' },
  { client: 'Fileball', device: 'iPhone', version: '1.4.1', ua: 'Fileball/1.4.1 (iPhone; iOS 18.0; Scale/3.00)' },
  { client: 'Infuse', device: 'iPhone', version: '8.1.2', ua: 'Infuse/8.1.2 (iPhone; iOS 18.0; Scale/3.00)' },
  { client: 'Emby for iOS', device: 'iPhone', version: '2.3.4', ua: 'Emby/2.3.4 (iPhone; iOS 18.0; Scale/3.00)' },
];

/** 读取响应体片段用于错误定位（截断，防超大响应） */
async function bodySnippet(res) {
  try {
    const text = await res.text();
    return text.replace(/\s+/g, ' ').slice(0, 160);
  } catch (_) { return ''; }
}

/** 登录 Emby，返回 { userId, token, serverId, identity }；失败抛错 */
async function loginEmby(line) {
  const base = buildBaseUrl(line);
  const url = `${base}/emby/Users/AuthenticateByName`;
  const errors = [];
  for (const identity of CLIENT_IDENTITIES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': identity.ua,
          'X-Emby-Authorization': `MediaBrowser Client="${identity.client}", Device="${identity.device}", DeviceId="emby-manager-cf", Version="${identity.version}"`,
        },
        body: JSON.stringify({ Username: line.username, Pw: line.password || '' }),
      });
    } catch (e) {
      throw new Error(`无法连接服务器 ${base}（超时或网络错误）`);
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      const data = await res.json();
      return { userId: data.User.Id, token: data.AccessToken, serverId: data.ServerId, identity };
    }
    // 401 说明请求已通过客户端过滤、到达认证环节，换身份也没用
    if (res.status === 401) throw new Error('用户名或密码错误');
    const snippet = await bodySnippet(res);
    if (snippet.includes('emby_login_disabled')) {
      throw new Error('站点按来源 IP 限制了登录（禁机房/海外 IP）。Cloudflare Workers 的出口是数据中心 IP，无法从本面板登录此线路；请改用该站提供的中转/海外友好线路，或联系站点管理员。');
    }
    errors.push(`${identity.client}: HTTP ${res.status}${snippet ? ' | ' + snippet : ''}`);
  }
  throw new Error(`请求地址 ${url} → ${errors.join('；')}`);
}

/** 拉取资源数量统计（Items/Counts），ua 沿用登录成功时的客户端身份 */
async function fetchCounts(baseUrl, token, ua) {
  const res = await embyFetch(baseUrl, `/emby/Items/Counts?api_key=${encodeURIComponent(token)}`, {
    headers: { 'User-Agent': ua },
  });
  if (!res.ok) throw new Error(`获取资源数量失败：HTTP ${res.status}`);
  const d = await res.json();
  return {
    movie: d.MovieCount || 0,
    series: d.SeriesCount || 0,
    episode: d.EpisodeCount || 0,
    song: d.SongCount || 0,
    album: d.AlbumCount || 0,
    book: d.BookCount || 0,
  };
}

/** 拉取最近一次观看时间：取当前用户的播放历史最新一条，ua 沿用登录成功时的客户端身份 */
async function fetchLastPlayed(baseUrl, token, userId, ua) {
  const path = `/emby/Users/${encodeURIComponent(userId)}/PlayedItems/Latest?Limit=1&api_key=${encodeURIComponent(token)}`;
  let res = await embyFetch(baseUrl, path, { headers: { 'User-Agent': ua } });
  if (res.ok) {
    const arr = await res.json().catch(() => []);
    if (Array.isArray(arr) && arr.length > 0) {
      const item = arr[0];
      const ts = item.UserData && (item.UserData.LastPlayedDate || item.UserData.LastPlayedDateUtc);
      if (ts) return { lastWatchedAt: ts, lastWatchedName: item.Name || item.SeriesName || '' };
    }
    return {};
  }
  // 后备方案：用 Items 接口按播放时间倒序
  const fallback = `/emby/Items?SortBy=DatePlayed&SortOrder=Descending&Limit=1&Filters=IsPlayed&Recursive=true` +
    `&UserId=${encodeURIComponent(userId)}&api_key=${encodeURIComponent(token)}`;
  res = await embyFetch(baseUrl, fallback, { headers: { 'User-Agent': ua } });
  if (!res.ok) throw new Error(`获取观看记录失败：HTTP ${res.status}`);
  const data = await res.json().catch(() => ({ Items: [] }));
  const item = data.Items && data.Items[0];
  if (!item || !item.UserData || !item.UserData.LastPlayedDate) return {};
  return { lastWatchedAt: item.UserData.LastPlayedDate, lastWatchedName: item.Name || item.SeriesName || '' };
}

// ---------- 密码加密（AES-GCM，密钥由 ENCRYPT_KEY 派生） ----------
// KV 中密码字段存为 "enc:v1:<ivBase64>:<cipherBase64>"；未配置 ENCRYPT_KEY 时退回明文。
const ENC_PREFIX = 'enc:v1:';

function cryptoKeyCache(env) {
  if (!env.__encKeyPromise) {
    if (!env.ENCRYPT_KEY) return null;
    env.__encKeyPromise = crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.ENCRYPT_KEY), 'PBKDF2', false, ['deriveKey']
    ).then(k => crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: new TextEncoder().encode('emby-manager-v1'), iterations: 100000, hash: 'SHA-256' },
      k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    ));
  }
  return env.__encKeyPromise;
}

async function encryptPassword(env, plain) {
  if (!plain) return '';
  const key = cryptoKeyCache(env);
  if (!key) return plain; // 未配置 ENCRYPT_KEY，保持明文
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, await key, new TextEncoder().encode(plain)
  );
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return `${ENC_PREFIX}${b64(iv)}:${b64(cipher)}`;
}

async function decryptPassword(env, stored) {
  if (!stored) return '';
  if (!stored.startsWith(ENC_PREFIX)) return stored; // 明文旧数据
  const key = cryptoKeyCache(env);
  if (!key) throw new Error('检测到加密数据但未配置 ENCRYPT_KEY');
  const [, , ivB64, cipherB64] = stored.split(':');
  const dec = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: dec(ivB64) }, await key, dec(cipherB64)
  );
  return new TextDecoder().decode(plain);
}

/** 解密账号对象中所有线路的密码，返回新对象 */
async function decryptAccountLines(env, account) {
  const lines = await Promise.all(account.lines.map(async l => ({
    ...l, password: await decryptPassword(env, l.password),
  })));
  return { ...account, lines };
}

/** 加密账号对象中所有线路的密码，返回待存储的新对象 */
async function encryptAccountLines(env, account) {
  const lines = await Promise.all(account.lines.map(async l => ({
    ...l, password: await encryptPassword(env, l.password),
  })));
  return { ...account, lines };
}

// ---------- 路由 ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!checkAuth(request, env)) {
      return json({ error: '需要访问密码' }, 401);
    }

    // API 路由
    if (path.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url, path);
      } catch (e) {
        return json({ error: e.message || '服务器内部错误' }, 500);
      }
    }

    // 静态页面
    if (path === '/' || path === '/index.html') {
      return new Response(HTML_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return new Response('Not Found', { status: 404 });
  },
};

async function handleApi(request, env, url, path) {
  const listKey = 'index:accounts';

  // 账号列表
  if (path === '/api/accounts' && request.method === 'GET') {
    const ids = JSON.parse((await env.KV.get(listKey)) || '[]');
    const accounts = await Promise.all(ids.map(id => env.KV.get(`acct:${id}`, 'json')));
    // 返回时隐藏密码字段
    return json(accounts.filter(Boolean).map(a => ({ ...a, lines: (a.lines || []).map(l => ({ ...l, password: '' })) })));
  }

  // 添加账号
  if (path === '/api/accounts' && request.method === 'POST') {
    const body = await request.json();
    const lines = (body.lines || []).filter(l => l.host && l.username);
    if (lines.length === 0) return json({ error: '至少需要一条有效线路（host + username）' }, 400);

    // 逐条线路尝试登录，成功一条即作为主线路
    let main = null;
    const lineResults = [];
    for (const line of lines) {
      try {
        const r = await loginEmby(line);
        if (!main) main = { line, ...r };
        lineResults.push({ name: line.name || line.host, ok: true });
      } catch (e) {
        lineResults.push({ name: line.name || line.host, ok: false, error: e.message });
      }
    }
    if (!main) {
      const errs = lineResults.map(r => `${r.name}: ${r.error}`).join('；');
      return json({ error: `所有线路均登录失败 → ${errs}` }, 400);
    }

    // 拉取初始数据
    const base = buildBaseUrl(main.line);
    let counts = null, lastPlayed = {};
    try { counts = await fetchCounts(base, main.token, main.identity.ua); } catch (_) {}
    try { lastPlayed = await fetchLastPlayed(base, main.token, main.userId, main.identity.ua); } catch (_) {}

    const id = crypto.randomUUID();
    const account = await encryptAccountLines(env, {
      id,
      name: body.name || main.line.username,
      note: body.note || '',
      lines: lines.map(l => ({ ...l, password: l.password || '' })),
      userId: main.userId,
      token: main.token,
      serverId: main.serverId,
      counts: counts || {},
      lastWatchedAt: lastPlayed.lastWatchedAt || null,
      lastWatchedName: lastPlayed.lastWatchedName || '',
      updatedAt: new Date().toISOString(),
    });
    const ids = JSON.parse((await env.KV.get(listKey)) || '[]');
    ids.push(id);
    await env.KV.put(listKey, JSON.stringify(ids));
    await env.KV.put(`acct:${id}`, JSON.stringify(account));
    // 返回给前端的副本隐藏密码
    const safe = { ...account, lines: account.lines.map(l => ({ ...l, password: '' })) };
    return json({ account: safe, lineResults });
  }

  // 单个账号
  const m = path.match(/^\/api\/accounts\/([\w-]+)(\/(refresh|test))?$/);
  if (m) {
    const id = m[1];
    const raw = await env.KV.get(`acct:${id}`);
    if (!raw) return json({ error: '账号不存在' }, 404);
    const account = JSON.parse(raw);

    if (request.method === 'DELETE') {
      const ids = JSON.parse((await env.KV.get(listKey)) || '[]').filter(x => x !== id);
      await env.KV.put(listKey, JSON.stringify(ids));
      await env.KV.delete(`acct:${id}`);
      return json({ ok: true });
    }

    // 编辑账号（PUT）：更新名称/备注/线路；密码留空表示保留原密码
    if (request.method === 'PUT') {
      const body = await request.json();
      const lines = (body.lines || []).filter(l => l.host && l.username);
      if (lines.length === 0) return json({ error: '至少需要一条有效线路（host + username）' }, 400);

      const dec = await decryptAccountLines(env, account);
      const keyOf = l => [l.host, l.port || '', l.path || '', l.username].map(s => String(s || '').trim().toLowerCase()).join('|');
      const oldPwd = new Map(dec.lines.map(l => [keyOf(l), l.password]));
      const merged = lines.map(l => ({ ...l, password: l.password || oldPwd.get(keyOf(l)) || '' }));

      account.name = (body.name || '').trim() || account.name;
      account.note = (body.note || '').trim();

      // 用新配置尝试登录并刷新数据（失败不阻塞保存，编辑本身一定生效）
      let loginOk = false, loginErr = null;
      for (const line of merged) {
        try {
          const login = await loginEmby(line);
          const base = buildBaseUrl(line);
          let counts = null, lastPlayed = {};
          try { counts = await fetchCounts(base, login.token, login.identity.ua); } catch (_) {}
          try { lastPlayed = await fetchLastPlayed(base, login.token, login.userId, login.identity.ua); } catch (_) {}
          Object.assign(account, {
            userId: login.userId, token: login.token, serverId: login.serverId,
            counts: counts || account.counts || {},
            lastWatchedAt: lastPlayed.lastWatchedAt || null,
            lastWatchedName: lastPlayed.lastWatchedName || '',
          });
          loginOk = true;
          break;
        } catch (e) { loginErr = e.message; }
      }

      account.lines = merged;
      account.updatedAt = new Date().toISOString();
      await env.KV.put(`acct:${id}`, JSON.stringify(await encryptAccountLines(env, account)));
      const safe = { ...account, lines: account.lines.map(l => ({ ...l, password: '' })) };
      return json({ ok: true, loginOk, error: loginOk ? undefined : loginErr, account: safe });
    }

    // 刷新：重新登录可用线路，更新观看时间与资源数量
    if (m[3] === 'refresh' && request.method === 'POST') {
      const dec = await decryptAccountLines(env, account);
      let result = null, lastErr = null;
      for (const line of dec.lines) {
        try {
          const login = await loginEmby(line);
          const base = buildBaseUrl(line);
          let counts = null, lastPlayed = {};
          try { counts = await fetchCounts(base, login.token, login.identity.ua); } catch (_) {}
          try { lastPlayed = await fetchLastPlayed(base, login.token, login.userId, login.identity.ua); } catch (_) {}
          result = {
            userId: login.userId, token: login.token, serverId: login.serverId,
            counts: counts || account.counts || {},
            lastWatchedAt: lastPlayed.lastWatchedAt || null,
            lastWatchedName: lastPlayed.lastWatchedName || '',
            viaLine: line.name || line.host,
          };
          break; // 第一条可用线路成功即停
        } catch (e) { lastErr = e; }
      }
      if (!result) return json({ error: `刷新失败：${lastErr ? lastErr.message : '所有线路不可用'}` }, 502);
      Object.assign(account, result, { updatedAt: new Date().toISOString() });
      delete account.viaLine;
      await env.KV.put(`acct:${id}`, JSON.stringify(await encryptAccountLines(env, account)));
      return json({ ...account, lines: account.lines.map(l => ({ ...l, password: '' })) });
    }

    // 测试所有线路连通性
    if (m[3] === 'test' && request.method === 'POST') {
      const dec = await decryptAccountLines(env, account);
      const results = [];
      for (const line of dec.lines) {
        try {
          await loginEmby(line);
          results.push({ name: line.name || line.host, ok: true });
        } catch (e) {
          results.push({ name: line.name || line.host, ok: false, error: e.message });
        }
      }
      return json(results);
    }

    return json({ error: '不支持的操作' }, 405);
  }

  return json({ error: '接口不存在' }, 404);
}

// ---------- 前端页面 ----------
const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Emby 账户</title>
<style>
  :root {
    --bg: #f5f5f7;
    --card: rgba(255,255,255,.72);
    --card-solid: #ffffff;
    --fill: rgba(120,120,128,.10);
    --sep: rgba(60,60,67,.14);
    --text: #1d1d1f;
    --text2: #6e6e73;
    --text3: #aeaeb2;
    --accent: #0071e3;
    --tint: rgba(0,113,227,.11);
    --green: #34c759; --red: #ff3b30;
    --shadow: 0 2px 8px rgba(0,0,0,.04), 0 12px 32px rgba(0,0,0,.06);
    --r-lg: 20px; --r-md: 14px; --r-sm: 10px;
    --ease: cubic-bezier(.32,.72,0,1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #000000;
      --card: rgba(28,28,30,.62);
      --card-solid: #1c1c1e;
      --fill: rgba(120,120,128,.22);
      --sep: rgba(84,84,88,.48);
      --text: #f5f5f7;
      --text2: #a1a1a6;
      --text3: #636366;
      --accent: #0a84ff;
      --tint: rgba(10,132,255,.16);
      --shadow: 0 2px 8px rgba(0,0,0,.4);
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 15px; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }
  ::selection { background: rgba(0,113,227,.25); }
  button { font: inherit; color: inherit; cursor: pointer; }
  :focus { outline: none; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: var(--sep); border-radius: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }

  .glow { position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background: radial-gradient(600px 400px at 15% -5%, rgba(10,132,255,.10), transparent 60%),
                radial-gradient(500px 380px at 85% -5%, rgba(175,82,222,.08), transparent 60%); }
  @media (prefers-color-scheme: dark) { .glow { opacity: .5; } }

  .wrap { position: relative; z-index: 1; max-width: 1020px; margin: 0 auto; padding: clamp(20px, 4vw, 40px) 20px 80px; }

  .top { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 30px; font-weight: 700; letter-spacing: -.02em; line-height: 1.15; }
  .sub { margin: 4px 0 0; color: var(--text2); font-size: 14px; }

  .btn {
    display: inline-flex; align-items: center; gap: 6px; justify-content: center;
    border: none; border-radius: 999px; padding: 9px 18px;
    font-size: 15px; font-weight: 600; background: var(--fill); color: var(--text);
    transition: transform .12s ease-out, filter .15s, background .15s;
    -webkit-tap-highlight-color: transparent; user-select: none;
  }
  .btn:hover { filter: brightness(1.05); }
  @media (hover: none) { .btn:hover { filter: none; } }
  .btn:active { transform: scale(.96); filter: brightness(.92); }
  .btn.primary { background: var(--accent); color: #fff; }
  .btn.tint { background: var(--tint); color: var(--accent); }
  .btn.danger { background: rgba(255,59,48,.12); color: var(--red); }
  .btn.ghost { background: transparent; color: var(--accent); }
  .btn.sq { width: 34px; height: 34px; padding: 0; border-radius: 50%; }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn:disabled:active { transform: none; }
  .ic16 { width: 16px; height: 16px; flex-shrink: 0; }
  .ic18 { width: 18px; height: 18px; flex-shrink: 0; }
  svg { display: block; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }

  .card {
    background: var(--card); backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
    border: 1px solid var(--sep); border-radius: var(--r-lg);
    padding: 18px; box-shadow: var(--shadow);
    transition: transform .12s ease-out, box-shadow .25s, border-color .25s;
    cursor: pointer; -webkit-tap-highlight-color: transparent;
  }
  .card:hover { border-color: color-mix(in srgb, var(--accent) 30%, var(--sep)); }
  .card:active { transform: scale(.985); }
  .card-top { display: flex; align-items: center; gap: 12px; }
  .avatar {
    width: 42px; height: 42px; border-radius: 12px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 18px; font-weight: 700; letter-spacing: 0;
  }
  .card-title { flex: 1; min-width: 0; }
  .card-title h3 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card-title p { margin: 1px 0 0; font-size: 13px; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chev { width: 18px; height: 18px; color: var(--text3); flex-shrink: 0; }
  .watch { display: flex; align-items: center; gap: 7px; margin-top: 14px; font-size: 13.5px; color: var(--text2); min-width: 0; }
  .watch b { font-weight: 500; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .watch .ic16 { color: var(--accent); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; font-weight: 500; color: var(--text2); background: var(--fill); border-radius: 999px; padding: 4px 10px; }
  .chip svg { width: 13px; height: 13px; }
  .card-actions { display: flex; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--sep); }
  .card-actions .btn { padding: 6px 14px; font-size: 13.5px; }
  .card-actions .spacer { flex: 1; }

  .empty { grid-column: 1 / -1; text-align: center; padding: 72px 0 56px; color: var(--text2); }
  .empty .eicon { width: 64px; height: 64px; margin: 0 auto 16px; border-radius: 18px; background: var(--tint); display: flex; align-items: center; justify-content: center; color: var(--accent); }
  .empty .eicon svg { width: 30px; height: 30px; }
  .empty h2 { margin: 0 0 6px; font-size: 19px; font-weight: 600; color: var(--text); letter-spacing: -.01em; }
  .empty p { margin: 0 0 20px; font-size: 14px; }

  .toast {
    position: fixed; top: max(16px, env(safe-area-inset-top)); left: 50%; z-index: 60;
    transform: translate(-50%, -16px); opacity: 0; pointer-events: none;
    max-width: min(90vw, 560px);
    background: var(--card-solid); color: var(--text);
    border: 1px solid var(--sep); border-radius: 999px; box-shadow: var(--shadow);
    padding: 10px 18px; font-size: 13.5px; font-weight: 500; text-align: center;
    transition: transform .3s var(--ease), opacity .25s;
  }
  .toast.show { transform: translate(-50%, 0); opacity: 1; }
  .toast.err { color: var(--red); }
  .toast.warn { color: var(--orange, #ff9500); }

  .overlay {
    position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,.4); padding: 16px;
    opacity: 0; transition: opacity .3s ease;
  }
  .overlay.open { opacity: 1; }
  .sheet {
    display: flex; flex-direction: column;
    width: min(560px, 100%); max-height: min(86vh, 760px);
    background: var(--bg);
    border-radius: var(--r-lg); box-shadow: 0 24px 80px rgba(0,0,0,.35);
    transform: translateY(24px) scale(.97); opacity: 0;
    transition: transform .4s var(--ease), opacity .25s ease;
    overflow: hidden;
  }
  .overlay.open .sheet { transform: translateY(0) scale(1); opacity: 1; }
  @media (max-width: 640px) {
    .overlay { padding: 0; align-items: flex-end; }
    .sheet { width: 100%; max-height: 92vh; border-radius: 20px 20px 0 0; transform: translateY(100%); }
  }
  .sheet-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 12px 16px; border-bottom: 1px solid var(--sep);
    background: var(--card); backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
    flex-shrink: 0;
  }
  .sheet-head h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
  .sheet-head .btn { padding: 5px 12px; font-size: 14px; }
  .sheet-body { flex: 1; overflow-y: auto; padding: 16px; overscroll-behavior: contain; }

  .sec { margin: 22px 0 8px; font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
  .sec:first-child { margin-top: 0; }

  .group {
    background: var(--card); backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
    border: 1px solid var(--sep); border-radius: var(--r-md); overflow: hidden;
  }
  .row { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 4px 14px; }
  .row + .row { border-top: 1px solid var(--sep); }
  .row-label { width: 72px; flex-shrink: 0; font-size: 15px; font-weight: 400; }
  .ipt {
    flex: 1; min-width: 0; border: none; background: transparent; color: var(--text);
    font: inherit; text-align: right; padding: 8px 0;
  }
  .ipt::placeholder { color: var(--text3); }
  .row .btn.sq { width: 30px; height: 30px; }

  .switch { position: relative; width: 46px; height: 28px; flex-shrink: 0; margin-left: auto; }
  .switch input {
    appearance: none; -webkit-appearance: none; margin: 0; width: 100%; height: 100%;
    border-radius: 999px; background: var(--fill); cursor: pointer;
    transition: background .2s ease; display: block;
  }
  .switch input:checked { background: var(--green); }
  .switch input::after {
    content: ''; position: absolute; top: 2px; left: 2px; width: 24px; height: 24px;
    border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0,0,0,.25);
    transition: left .22s var(--ease);
  }
  .switch input:checked::after { left: 20px; }

  .line { margin-bottom: 14px; }
  .line-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 14px; font-weight: 600; color: var(--text2); }
  .line-head .grow { flex: 1; }
  .badge { font-size: 11.5px; font-weight: 600; color: var(--accent); background: var(--tint); border-radius: 999px; padding: 2px 9px; }

  .addline { width: 100%; border: 1.5px dashed var(--sep); background: transparent; border-radius: var(--r-md); padding: 12px; color: var(--accent); font-weight: 500; justify-content: center; }
  .addline:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--sep)); }

  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
  .tile { display: flex; align-items: center; gap: 11px; padding: 13px 14px; border-radius: var(--r-md); background: color-mix(in srgb, var(--c) 11%, transparent); }
  .tile svg { width: 20px; height: 20px; color: var(--c); flex-shrink: 0; }
  .tile .tnum { font-size: 19px; font-weight: 700; letter-spacing: -.02em; line-height: 1.1; }
  .tile .tlabel { font-size: 12px; color: var(--text2); }

  .watchrow { display: flex; align-items: flex-start; gap: 12px; padding: 14px; border-radius: var(--r-md); background: var(--card); border: 1px solid var(--sep); backdrop-filter: blur(28px) saturate(180%); -webkit-backdrop-filter: blur(28px) saturate(180%); }
  .watchrow svg { color: var(--accent); margin-top: 2px; }
  .watchrow .wt { flex: 1; min-width: 0; }
  .watchrow b { display: block; font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
  .watchrow span { display: block; font-size: 13px; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .linestatus .row { min-height: 44px; }
  .lstate { display: flex; align-items: center; gap: 6px; font-size: 13px; text-align: right; }
  .lstate .dot2 { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .lstate.ok { color: var(--green); } .lstate.ok .dot2 { background: var(--green); }
  .lstate.bad { color: var(--red); } .lstate.bad .dot2 { background: var(--red); }
  .lstate.unknown { color: var(--text3); } .lstate.unknown .dot2 { background: var(--text3); }

  .sheet-actions { display: flex; gap: 8px; margin-top: 20px; flex-wrap: wrap; }
  .sheet-actions .btn { flex: 1; min-width: 100px; }
  .hint { font-size: 12.5px; color: var(--text3); margin: 10px 2px 0; }
  .formmsg { margin-top: 12px; }
  .formmsg .msg { padding: 10px 14px; border-radius: var(--r-sm); font-size: 13px; background: rgba(255,59,48,.1); color: var(--red); word-break: break-all; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition-duration: .01ms !important; animation: none !important; }
    .btn:active, .card:active { transform: none; }
  }
  @media (prefers-reduced-transparency: reduce) {
    .card, .group, .watchrow, .sheet-head { backdrop-filter: none; -webkit-backdrop-filter: none; background: var(--card-solid); }
  }
</style>
</head>
<body>
<div class="glow"></div>
<main class="wrap">
  <header class="top">
    <div>
      <h1>账户</h1>
      <p class="sub" id="summary"></p>
    </div>
    <button class="btn primary" id="btnAdd"></button>
  </header>
  <section id="list" class="grid"></section>
</main>

<div class="toast" id="toast" role="status"></div>

<div class="overlay" id="editOverlay" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="editTitle">
    <header class="sheet-head">
      <button class="btn ghost" id="btnCancel">取消</button>
      <h2 id="editTitle">添加账户</h2>
      <button class="btn primary" id="btnSave">保存</button>
    </header>
    <div class="sheet-body">
      <div class="group">
        <div class="row"><span class="row-label">名称</span><input class="ipt" id="f_name" placeholder="可选"></div>
        <div class="row"><span class="row-label">备注</span><input class="ipt" id="f_note" placeholder="可选"></div>
      </div>
      <h3 class="sec">服务器线路</h3>
      <div id="lines"></div>
      <button type="button" class="addline btn" id="btnAddLine"></button>
      <div class="formmsg" id="formMsg"></div>
    </div>
  </div>
</div>

<div class="overlay" id="detailOverlay" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="d_name">
    <header class="sheet-head">
      <button class="btn ghost" id="btnDetailClose">关闭</button>
      <h2 id="d_name"></h2>
      <span style="width:52px"></span>
    </header>
    <div class="sheet-body" id="d_body"></div>
  </div>
</div>

<script>
var ICONS = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  tv: '<rect width="20" height="15" x="2" y="7" rx="2"/><polyline points="17 2 12 7 7 2"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
  layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  disc: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="2"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>'
};
function ic(name, cls) {
  return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
}

var STAT_DEFS = [
  ['film', '电影', 'movie', '#0a84ff'],
  ['tv', '剧集', 'series', '#af52de'],
  ['layers', '集数', 'episode', '#5e5ce6'],
  ['music', '歌曲', 'song', '#ff2d55'],
  ['disc', '专辑', 'album', '#ff9500'],
  ['book', '图书', 'book', '#30b0c7']
];

var ACCOUNTS = [];
var editingId = null;

function $(s) { return document.querySelector(s); }

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function fmtNum(n) { return Number(n || 0).toLocaleString('zh-CN'); }

function relTime(ts) {
  if (!ts) return '暂无观看';
  var s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
  return new Date(ts).toLocaleDateString('zh-CN');
}
function fmtFull(ts) {
  return new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function hashHue(str) {
  var h = 0;
  for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

var toastTimer = null;
function toast(msg, type) {
  var t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { t.className = 'toast'; }, 3800);
}

async function api(path, opts) {
  opts = opts || {};
  var pwd = sessionStorage.getItem('panelPwd') || '';
  var sep = path.indexOf('?') >= 0 ? '&' : '?';
  var res = await fetch(path + sep + 'pwd=' + encodeURIComponent(pwd), {
    headers: Object.assign({ 'X-Panel-Password': pwd, 'Content-Type': 'application/json' }, opts.headers || {}),
    method: opts.method || 'GET',
    body: opts.body
  });
  var data = await res.json().catch(function() { return {}; });
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

async function loadAccounts() {
  try {
    ACCOUNTS = await api('/api/accounts');
    render();
  } catch (e) { toast('加载失败：' + e.message, 'err'); }
}

function render() {
  var el = $('#list');
  $('#summary').textContent = ACCOUNTS.length ? '共 ' + ACCOUNTS.length + ' 个账户' : '';
  if (!ACCOUNTS.length) {
    el.innerHTML = '<div class="empty"><div class="eicon">' + ic('server') + '</div>' +
      '<h2>还没有账户</h2><p>添加你的第一个 Emby 账户，跟踪观看记录与媒体库</p>' +
      '<button class="btn primary" id="btnEmptyAdd">' + ic('plus', 'ic16') + '添加账户</button></div>';
    return;
  }
  el.innerHTML = ACCOUNTS.map(cardHtml).join('');
}

function chip(icon, n, label) {
  return '<span class="chip">' + ic(icon) + fmtNum(n) + ' ' + label + '</span>';
}

function cardHtml(a) {
  var c = a.counts || {};
  var chips = [];
  for (var i = 0; i < STAT_DEFS.length; i++) {
    var d = STAT_DEFS[i];
    if (c[d[2]]) chips.push(chip(d[0], c[d[2]], d[1]));
  }
  var hue = hashHue(a.id || a.name || 'e');
  var watch = a.lastWatchedAt
    ? esc(relTime(a.lastWatchedAt)) + (a.lastWatchedName ? ' · <b>' + esc(a.lastWatchedName) + '</b>' : '')
    : '暂无观看记录';
  return '<article class="card" data-id="' + a.id + '" tabindex="0" role="button" aria-label="查看 ' + esc(a.name) + ' 详情">' +
    '<div class="card-top">' +
      '<div class="avatar" style="background:linear-gradient(135deg,hsl(' + hue + ',72%,62%),hsl(' + ((hue + 45) % 360) + ',72%,50%))">' + esc((a.name || 'E').charAt(0).toUpperCase()) + '</div>' +
      '<div class="card-title"><h3>' + esc(a.name) + '</h3>' + (a.note ? '<p>' + esc(a.note) + '</p>' : '') + '</div>' +
      ic('chevron', 'chev') +
    '</div>' +
    '<div class="watch">' + ic('clock', 'ic16') + '<span>' + watch + '</span></div>' +
    (chips.length ? '<div class="chips">' + chips.join('') + '</div>' : '') +
    '<div class="card-actions">' +
      '<button class="btn tint" data-action="refresh" data-id="' + a.id + '">' + ic('refresh', 'ic16') + '刷新</button>' +
      '<button class="btn tint" data-action="edit" data-id="' + a.id + '">' + ic('pencil', 'ic16') + '编辑</button>' +
      '<span class="spacer"></span>' +
      '<button class="btn danger sq" data-action="del" data-id="' + a.id + '" aria-label="删除">' + ic('trash', 'ic16') + '</button>' +
    '</div>' +
  '</article>';
}

// ---------- 弹层 ----------
function openOverlay(ov) {
  ov.hidden = false;
  requestAnimationFrame(function() { requestAnimationFrame(function() { ov.classList.add('open'); }); });
  var f = ov.querySelector('input, .btn');
  if (f) setTimeout(function() { f.focus(); }, 120);
}
function closeOverlay(ov) {
  ov.classList.remove('open');
  setTimeout(function() { ov.hidden = true; }, 420);
}
function topOverlay() {
  var ovs = document.querySelectorAll('.overlay:not([hidden])');
  return ovs.length ? ovs[ovs.length - 1] : null;
}

// ---------- 表单 ----------
function rowHtml(cls, label, val, ph, extra) {
  return '<div class="row"><span class="row-label">' + label + '</span>' +
    '<input class="ipt ' + cls + '" value="' + esc(val) + '" placeholder="' + ph + '"' + (extra || '') + '></div>';
}

function lineBox(d, idx) {
  d = d || { name: '', host: '', path: '', port: '', https: false, username: '', password: '' };
  var box = document.createElement('section');
  box.className = 'line';
  box.innerHTML =
    '<div class="line-head"><span class="lt">线路 ' + (idx + 1) + '</span>' +
      (idx === 0 ? '<span class="badge">主线路</span>' : '') +
      '<span class="grow"></span>' +
      '<button type="button" class="btn ghost sq" data-action="delline" aria-label="删除此线路">' + ic('x', 'ic16') + '</button>' +
    '</div>' +
    '<div class="group">' +
      rowHtml('l_name', '线路名称', d.name, '可选') +
      rowHtml('l_host', '主机', d.host, '必填') +
      rowHtml('l_path', '路径', d.path, '可选') +
      rowHtml('l_port', '端口', d.port, '可选', ' inputmode="numeric"') +
      '<div class="row"><span class="row-label">https</span><label class="switch"><input type="checkbox" class="l_https"' + (d.https ? ' checked' : '') + '></label></div>' +
      rowHtml('l_user', '用户', d.username, '必填') +
      '<div class="row"><span class="row-label">密码</span>' +
        '<input class="ipt l_pass" type="password" value="' + esc(d.password) + '" placeholder="可选">' +
        '<button type="button" class="btn ghost sq" data-action="eye" aria-label="显示密码">' + ic('eye', 'ic16') + '</button>' +
      '</div>' +
    '</div>';
  return box;
}

function renumberLines() {
  var boxes = document.querySelectorAll('#lines .line');
  for (var i = 0; i < boxes.length; i++) {
    var head = boxes[i].querySelector('.line-head');
    var badge = head.querySelector('.badge');
    if (badge) badge.remove();
    head.querySelector('.lt').textContent = '线路 ' + (i + 1);
    if (i === 0) {
      var b = document.createElement('span');
      b.className = 'badge';
      b.textContent = '主线路';
      head.insertBefore(b, head.querySelector('.lt').nextSibling);
    }
  }
}

function addLine(d) {
  $('#lines').appendChild(lineBox(d, document.querySelectorAll('#lines .line').length));
  renumberLines();
}

function collectLines() {
  var lines = [];
  document.querySelectorAll('#lines .line').forEach(function(box) {
    var val = function(c) { var el = box.querySelector('.' + c); return el ? el.value.trim() : ''; };
    lines.push({
      name: val('l_name'), host: val('l_host'), path: val('l_path'),
      port: val('l_port'), username: val('l_user'), password: val('l_pass'),
      https: box.querySelector('.l_https').checked
    });
  });
  return lines;
}

function openAdd() {
  editingId = null;
  $('#editTitle').textContent = '添加账户';
  $('#f_name').value = '';
  $('#f_note').value = '';
  $('#lines').innerHTML = '';
  $('#formMsg').innerHTML = '';
  addLine();
  openOverlay($('#editOverlay'));
}

function openEdit(id) {
  var a = ACCOUNTS.find(function(x) { return x.id === id; });
  if (!a) return;
  editingId = id;
  $('#editTitle').textContent = '编辑账户';
  $('#f_name').value = a.name || '';
  $('#f_note').value = a.note || '';
  $('#lines').innerHTML = '';
  $('#formMsg').innerHTML = '';
  var lines = a.lines && a.lines.length ? a.lines : [{}];
  for (var i = 0; i < lines.length; i++) addLine(lines[i]);
  openOverlay($('#editOverlay'));
}

async function save() {
  var btn = $('#btnSave');
  var lines = collectLines().filter(function(l) { return l.host && l.username; });
  if (!lines.length) {
    $('#formMsg').innerHTML = '<div class="msg">至少填写一条线路的主机和用户名</div>';
    return;
  }
  btn.disabled = true;
  var payload = {
    name: $('#f_name').value.trim(),
    note: $('#f_note').value.trim(),
    lines: lines
  };
  try {
    if (editingId) {
      var r = await api('/api/accounts/' + editingId, { method: 'PUT', body: JSON.stringify(payload) });
      closeOverlay($('#editOverlay'));
      if (r.loginOk) toast('已保存并验证通过');
      else toast('已保存，但登录验证未通过：' + (r.error || '未知原因'), 'warn');
      await loadAccounts();
    } else {
      await api('/api/accounts', { method: 'POST', body: JSON.stringify(payload) });
      closeOverlay($('#editOverlay'));
      toast('账户已添加');
      await loadAccounts();
    }
  } catch (e) {
    $('#formMsg').innerHTML = '<div class="msg">' + esc(e.message) + '</div>';
  } finally { btn.disabled = false; }
}

// ---------- 卡片操作 ----------
async function refresh(id) {
  var btn = document.querySelector('[data-action="refresh"][data-id="' + id + '"]');
  if (btn) btn.disabled = true;
  toast('正在刷新…');
  try {
    await api('/api/accounts/' + id + '/refresh', { method: 'POST' });
    toast('已更新');
    await loadAccounts();
    var ov = topOverlay();
    if (ov && ov.id === 'detailOverlay') openDetail(id, true);
  } catch (e) { toast('刷新失败：' + e.message, 'err'); }
  finally { if (btn) btn.disabled = false; }
}

async function del(id) {
  var a = ACCOUNTS.find(function(x) { return x.id === id; });
  if (!a || !confirm('确定删除账户「' + a.name + '」？此操作不可撤销。')) return;
  try {
    await api('/api/accounts/' + id, { method: 'DELETE' });
    var ov = topOverlay();
    if (ov && ov.id === 'detailOverlay') closeOverlay(ov);
    toast('已删除');
    await loadAccounts();
  } catch (e) { toast('删除失败：' + e.message, 'err'); }
}

// ---------- 详情 ----------
function tileHtml(def, c) {
  var n = c[def[2]] || 0;
  return '<div class="tile" style="--c:' + def[3] + '">' + ic(def[0]) +
    '<div><div class="tnum">' + fmtNum(n) + '</div><div class="tlabel">' + def[1] + '</div></div></div>';
}

function openDetail(id, keepScroll) {
  var a = ACCOUNTS.find(function(x) { return x.id === id; });
  if (!a) return;
  var c = a.counts || {};
  $('#d_name').textContent = a.name;
  var watch = '<div class="watchrow">' + ic('clock', 'ic18') + '<div class="wt">' +
    '<b>' + (a.lastWatchedAt ? relTime(a.lastWatchedAt) : '暂无观看记录') + '</b>' +
    (a.lastWatchedName ? '<span>' + esc(a.lastWatchedName) + '</span>' : '') +
    (a.lastWatchedAt ? '<span class="hint">' + fmtFull(a.lastWatchedAt) + '</span>' : '') +
    '</div></div>';
  var tiles = STAT_DEFS.map(function(d) { return tileHtml(d, c); }).join('');
  var lineRows = (a.lines || []).map(function(l, i) {
    return '<div class="row"><span class="row-label">' + esc(l.name || ('线路 ' + (i + 1))) + '</span>' +
      '<span class="ipt" style="color:var(--text2)">' + esc((l.https ? 'https://' : 'http://') + l.host + (l.port ? ':' + l.port : '') + (l.path || '')) + '</span>' +
      '<span class="lstate unknown" data-ls="' + i + '"><span class="dot2"></span>未测试</span></div>';
  }).join('');
  $('#d_body').innerHTML =
    '<h3 class="sec">最近观看</h3>' + watch +
    '<h3 class="sec">资源数量</h3><div class="tiles">' + tiles + '</div>' +
    '<h3 class="sec">线路</h3><div class="group linestatus">' + lineRows + '</div>' +
    '<p class="hint">测试线路将逐条尝试登录，检查连通性。</p>' +
    '<div class="sheet-actions">' +
      '<button class="btn primary" data-action="refresh" data-id="' + a.id + '">' + ic('refresh', 'ic16') + '刷新数据</button>' +
      '<button class="btn tint" data-action="test" data-id="' + a.id + '">' + ic('activity', 'ic16') + '测试线路</button>' +
      '<button class="btn tint" data-action="edit" data-id="' + a.id + '">' + ic('pencil', 'ic16') + '编辑</button>' +
    '</div>';
  openOverlay($('#detailOverlay'));
}

async function testLines(id) {
  var a = ACCOUNTS.find(function(x) { return x.id === id; });
  if (!a) return;
  var marks = document.querySelectorAll('#d_body .lstate');
  marks.forEach(function(m) { m.className = 'lstate unknown'; m.innerHTML = '<span class="dot2"></span>测试中'; });
  try {
    var results = await api('/api/accounts/' + id + '/test', { method: 'POST' });
    marks.forEach(function(m, i) {
      var r = results[i];
      if (!r) return;
      if (r.ok) { m.className = 'lstate ok'; m.innerHTML = '<span class="dot2"></span>可用'; }
      else {
        m.className = 'lstate bad';
        m.innerHTML = '<span class="dot2"></span>';
        m.title = r.error || '失败';
        var txt = document.createElement('span');
        txt.textContent = (r.error || '失败');
        m.appendChild(txt);
      }
    });
  } catch (e) { toast('测试失败：' + e.message, 'err'); }
}

function toggleEye(btn) {
  var input = btn.parentElement.querySelector('.l_pass');
  var show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.innerHTML = ic(show ? 'eyeoff' : 'eye', 'ic16');
}

// ---------- 事件 ----------
document.addEventListener('click', function(e) {
  var ov = e.target.classList && e.target.classList.contains('overlay') ? e.target : null;
  var act = e.target.closest('[data-action]');
  if (act) {
    var id = act.getAttribute('data-id');
    var action = act.getAttribute('data-action');
    if (action === 'refresh') refresh(id);
    else if (action === 'edit') openEdit(id);
    else if (action === 'del') del(id);
    else if (action === 'test') testLines(id);
    else if (action === 'eye') toggleEye(act);
    else if (action === 'delline') { act.closest('.line').remove(); renumberLines(); }
    return;
  }
  if (e.target.closest('#btnAdd') || e.target.closest('#btnEmptyAdd')) { openAdd(); return; }
  if (e.target.closest('#btnSave')) { save(); return; }
  if (e.target.closest('#btnCancel')) { closeOverlay($('#editOverlay')); return; }
  if (e.target.closest('#btnDetailClose')) { closeOverlay($('#detailOverlay')); return; }
  if (e.target.closest('#btnAddLine')) { addLine(); return; }
  var card = e.target.closest('.card');
  if (card) { openDetail(card.getAttribute('data-id')); return; }
  if (ov) closeOverlay(ov);
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    var ov = topOverlay();
    if (ov) { closeOverlay(ov); e.preventDefault(); }
  }
});
document.addEventListener('keydown', function(e) {
  var card = e.target.closest && e.target.closest('.card');
  if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDetail(card.getAttribute('data-id')); }
});

function initChrome() {
  $('#btnAdd').innerHTML = ic('plus', 'ic16') + '添加账户';
  $('#btnAddLine').innerHTML = ic('plus', 'ic16') + '添加备用线路';
}
initChrome();
loadAccounts();
</script>
</body>
</html>
`;
