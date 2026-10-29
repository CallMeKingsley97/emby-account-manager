/**
 * Emby 账号管理器 — Cloudflare Workers (KV 存储)
 *
 * 数据模型 (KV: key = "acct:<id>")：
 * {
 *   id, name, note,
 *   lines: [{ name, host, path, port, https, username, password }],  // 主线路为 lines[0]
 *   userId, token, client,  // 登录成功后缓存的会话（client 为命中的客户端身份）
 *   serverId, server: { name, version },
 *   activeLine,             // 当前使用的线路下标
 *   lineStats: [{ ok, ms, error, checkedAt }],  // 各线路延迟（从 Cloudflare 测得）
 *   user: { isDisabled },
 *   health: { ok, error, checkedAt },           // 最近一次刷新/巡检结果
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

const DEVICE_ID = 'emby-manager-cf';

/** 按缓存的 client 名取身份，找不到用第一个 */
function identityOf(client) {
  return CLIENT_IDENTITIES.find(i => i.client === client) || CLIENT_IDENTITIES[0];
}

/** Workers 子请求数超限：不能当成"服务器连不上"，要原样抛出 */
function isSubrequestLimit(e) {
  return /subrequest/i.test((e && e.message) || '');
}

function networkError(e, base) {
  if (isSubrequestLimit(e)) return e;
  return new Error(`无法连接服务器 ${base}（超时或网络错误）`);
}

/** 带 token 的 GET，返回 JSON；HTTP 错误带 status，网络错误带 network 标记 */
async function embyGet(base, path, token, ua) {
  const sep = path.includes('?') ? '&' : '?';
  let res;
  try {
    res = await embyFetch(base, `${path}${sep}api_key=${encodeURIComponent(token)}`, { headers: { 'User-Agent': ua } });
  } catch (e) {
    const err = networkError(e, base);
    err.network = !isSubrequestLimit(e);
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** 探测线路：无需登录的 System/Info/Public，顺带拿服务器名/版本/ID 和延迟 */
async function probeLine(line) {
  const base = buildBaseUrl(line);
  const t0 = Date.now();
  let res;
  try {
    res = await embyFetch(base, '/emby/System/Info/Public', {}, 8000);
  } catch (e) {
    if (isSubrequestLimit(e)) throw e;
    return { ok: false, error: '超时或网络错误' };
  }
  const ms = Date.now() - t0;
  if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}` };
  const d = await res.json().catch(() => null);
  if (!d) return { ok: false, ms, error: '响应不是 Emby 接口' };
  return { ok: true, ms, info: { id: d.Id || '', name: d.ServerName || '', version: d.Version || '' } };
}

/** 账号状态：Policy.IsDisabled（被服主禁用时为 true） */
async function fetchUserStatus(base, token, userId, ua) {
  const u = await embyGet(base, `/emby/Users/${encodeURIComponent(userId)}`, token, ua);
  return { isDisabled: !!(u.Policy && u.Policy.IsDisabled) };
}

/** 登录 Emby，返回 { userId, token, serverId, identity }；失败抛错。preferClient 命中的身份优先尝试 */
async function loginEmby(line, preferClient) {
  const base = buildBaseUrl(line);
  const url = `${base}/emby/Users/AuthenticateByName`;
  const errors = [];
  const identities = preferClient
    ? [identityOf(preferClient), ...CLIENT_IDENTITIES.filter(i => i.client !== preferClient)]
    : CLIENT_IDENTITIES;
  for (const identity of identities) {
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
          'X-Emby-Authorization': `MediaBrowser Client="${identity.client}", Device="${identity.device}", DeviceId="${DEVICE_ID}", Version="${identity.version}"`,
        },
        body: JSON.stringify({ Username: line.username, Pw: line.password || '' }),
      });
    } catch (e) {
      throw networkError(e, base);
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
  if (plain.startsWith(ENC_PREFIX)) return plain; // 已是密文，防止重复加密
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
  const plain = new TextDecoder().decode(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: dec(ivB64) }, await key, dec(cipherB64)
  ));
  // 旧版本刷新时会把密文再加密一次，这里逐层解开
  return plain.startsWith(ENC_PREFIX) ? decryptPassword(env, plain) : plain;
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

// ---------- 刷新 / 会话 ----------

/**
 * 刷新账号数据，直接修改 account（KV 中的原始对象，密码保持密文）。
 * - 优先复用缓存 token，失效才重新登录（减少登录记录与子请求）
 * - measure: 先并行探测所有线路，按延迟选线路；否则从 activeLine 开始依次尝试
 * - forceLogin: 编辑后密码可能改了，必须重新登录验证
 * 全部失败时写入 health 并抛错。
 */
async function refreshAccount(env, account, { measure = false, forceLogin = false } = {}) {
  const dec = await decryptAccountLines(env, account);
  const n = dec.lines.length;
  let order = dec.lines.map((_, i) => i);
  const active = account.activeLine < n ? account.activeLine : 0;
  order = [active, ...order.filter(i => i !== active)];

  let probes = null;
  if (measure) {
    probes = await Promise.all(dec.lines.map(probeLine));
    const now = new Date().toISOString();
    account.lineStats = probes.map(p => ({ ok: p.ok, ms: p.ms ?? null, error: p.error || '', checkedAt: now }));
    // 能连通的按延迟升序，不通的放最后（仍会尝试，探测失败不代表登录一定失败）
    const key = i => (probes[i].ok ? probes[i].ms : 1e9);
    order = dec.lines.map((_, i) => i).sort((a, b) => key(a) - key(b));
  }

  const errors = [];
  for (const idx of order) {
    const line = dec.lines[idx];
    const base = buildBaseUrl(line);
    try {
      let session = null, user = null;
      if (!forceLogin && account.token && account.userId) {
        const ua = identityOf(account.client).ua;
        try {
          user = await fetchUserStatus(base, account.token, account.userId, ua);
          session = { token: account.token, userId: account.userId, client: account.client, ua };
        } catch (e) {
          if (e.network || isSubrequestLimit(e)) throw e; // 线路不通，换下一条
          // 有 HTTP 响应（token 过期 / 被拒）→ 下面重新登录
        }
      }
      if (!session) {
        const login = await loginEmby(line, account.client);
        session = { token: login.token, userId: login.userId, client: login.identity.client, ua: login.identity.ua, serverId: login.serverId };
        user = await fetchUserStatus(base, session.token, session.userId, session.ua).catch(e => {
          if (isSubrequestLimit(e)) throw e;
          return null;
        });
      }

      const soft = p => p.catch(e => { if (isSubrequestLimit(e)) throw e; return null; });
      const needProbe = !probes && !account.server;
      const [counts, lastPlayed, probe] = await Promise.all([
        soft(fetchCounts(base, session.token, session.ua)),
        soft(fetchLastPlayed(base, session.token, session.userId, session.ua)),
        needProbe ? soft(probeLine(line)) : Promise.resolve(probes ? probes[idx] : null),
      ]);

      Object.assign(account, {
        userId: session.userId, token: session.token, client: session.client,
        activeLine: idx,
        health: { ok: true, error: '', checkedAt: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      });
      if (session.serverId) account.serverId = session.serverId;
      if (user) account.user = user;
      if (counts) account.counts = counts;
      // 拉取失败时保留旧值；成功但没有记录才清空
      if (lastPlayed) {
        account.lastWatchedAt = lastPlayed.lastWatchedAt || null;
        account.lastWatchedName = lastPlayed.lastWatchedName || '';
      }
      if (probe && probe.ok) {
        account.server = { name: probe.info.name, version: probe.info.version };
        if (probe.info.id) account.serverId = probe.info.id;
      }
      return account;
    } catch (e) {
      if (isSubrequestLimit(e)) throw e;
      errors.push(`${line.name || line.host}: ${e.message}`);
    }
  }
  account.health = { ok: false, error: errors.join('；') || '没有可用线路', checkedAt: new Date().toISOString() };
  throw new Error(account.health.error);
}

/** 用缓存会话调用 fn(base, token, userId, ua)；token 失效（401）时重新登录一次并回写 KV */
async function withSession(env, account, fn) {
  const dec = await decryptAccountLines(env, account);
  const idx = account.activeLine < dec.lines.length ? account.activeLine : 0;
  const line = dec.lines[idx];
  const base = buildBaseUrl(line);
  if (account.token && account.userId) {
    try {
      return await fn(base, account.token, account.userId, identityOf(account.client).ua);
    } catch (e) {
      if (e.status !== 401) throw e;
    }
  }
  const login = await loginEmby(line, account.client);
  Object.assign(account, { token: login.token, userId: login.userId, client: login.identity.client });
  await env.KV.put(`acct:${account.id}`, JSON.stringify(account));
  return fn(base, login.token, login.userId, login.identity.ua);
}

/** 精简条目字段，只留前端展示需要的 */
function slimItem(it) {
  const ud = it.UserData || {};
  return {
    name: it.Name || '', type: it.Type || '', series: it.SeriesName || '',
    season: it.ParentIndexNumber ?? null, episode: it.IndexNumber ?? null,
    year: it.ProductionYear || null,
    percent: ud.PlayedPercentage ? Math.round(ud.PlayedPercentage) : null,
    lastPlayed: ud.LastPlayedDate || null,
    childCount: it.ChildCount || null,
  };
}

/** 详情页实时内容：在线会话 / 继续观看 / 下一集 / 最近入库 / 收藏 / 媒体库 */
async function fetchContent(base, token, userId, ua) {
  const uid = encodeURIComponent(userId);
  const F = 'Fields=UserData,ProductionYear&EnableImages=false';
  const calls = {
    views: embyGet(base, `/emby/Users/${uid}/Views`, token, ua),
    resume: embyGet(base, `/emby/Users/${uid}/Items/Resume?Limit=10&MediaTypes=Video&${F}`, token, ua),
    nextUp: embyGet(base, `/emby/Shows/NextUp?UserId=${uid}&Limit=10&${F}`, token, ua),
    latest: embyGet(base, `/emby/Users/${uid}/Items/Latest?Limit=12&GroupItems=true&${F}`, token, ua),
    favorites: embyGet(base, `/emby/Users/${uid}/Items?Filters=IsFavorite&Recursive=true&IncludeItemTypes=Movie,Series&SortBy=SortName&Limit=20&${F}`, token, ua),
    sessions: embyGet(base, `/emby/Sessions`, token, ua),
  };
  const keys = Object.keys(calls);
  const settled = await Promise.allSettled(keys.map(k => calls[k]));
  // Views 任何用户都能访问：它 401 说明 token 失效，交给 withSession 重新登录
  if (settled[0].status === 'rejected' && settled[0].reason.status === 401) throw settled[0].reason;

  const out = {};
  keys.forEach((k, i) => {
    const r = settled[i];
    if (r.status === 'rejected') { out[k] = { error: r.reason.message }; return; }
    const v = r.value;
    const items = Array.isArray(v) ? v : (v.Items || []);
    if (k === 'views') {
      out[k] = items.map(x => ({ name: x.Name || '', type: x.CollectionType || '' }));
    } else if (k === 'sessions') {
      // 非管理员通常只能看到自己的会话；管理员能看到全部，按 UserId 过滤。排除本面板自身
      out[k] = items
        .filter(s => s.UserId === userId && s.DeviceId !== DEVICE_ID)
        .map(s => ({
          device: s.DeviceName || '', client: s.Client || '', ip: s.RemoteEndPoint || '',
          lastActivity: s.LastActivityDate || null,
          playing: s.NowPlayingItem ? slimItem(s.NowPlayingItem) : null,
          paused: !!(s.PlayState && s.PlayState.IsPaused),
        }));
    } else {
      out[k] = items.map(slimItem);
    }
  });
  return out;
}

// ---------- 定时巡检 + 通知 ----------

async function notify(env, title, text) {
  const tasks = [];
  if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
    tasks.push(fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: `${title}\n\n${text}`, disable_web_page_preview: true }),
    }).then(async r => { if (!r.ok) throw new Error(`Telegram HTTP ${r.status} ${await bodySnippet(r)}`); }));
  }
  if (env.BARK_URL) {
    // BARK_URL 形如 https://api.day.app/<key>
    tasks.push(fetch(env.BARK_URL.replace(/\/+$/, ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body: text, group: 'Emby' }),
    }).then(async r => { if (!r.ok) throw new Error(`Bark HTTP ${r.status} ${await bodySnippet(r)}`); }));
  }
  if (!tasks.length) return { sent: 0 };
  const rs = await Promise.allSettled(tasks);
  const errs = rs.filter(r => r.status === 'rejected').map(r => r.reason.message);
  if (errs.length) throw new Error(errs.join('；'));
  return { sent: tasks.length };
}

/** 状态变化才提醒，避免每次巡检重复推送 */
function healthAlert(prev, a) {
  const name = a.name || a.id;
  const wasOk = !prev.health || prev.health.ok !== false;
  if (wasOk && a.health && !a.health.ok) return `❌ ${name}：所有线路不可用\n${String(a.health.error).slice(0, 200)}`;
  if (!wasOk && a.health && a.health.ok) return `✅ ${name}：已恢复`;
  const wasDisabled = !!(prev.user && prev.user.isDisabled);
  if (!wasDisabled && a.user && a.user.isDisabled) return `⛔ ${name}：账号已被服务器禁用`;
  return null;
}

// ---------- 面板设置（KV: settings，页面可改） ----------
const DEFAULT_SETTINGS = {
  cronEnabled: false,       // 自动巡检，默认关闭
  checkIntervalHours: 24,   // 同一账号两次巡检的最短间隔（手动刷新也算一次检查）
  cronBatch: 3,             // 每次触发最多检查几个账号
  autoLoadContent: false,   // 打开详情页时自动拉取实时内容
  inactiveDays: 30,         // 超过多少天未观看提示
};
const INTERVAL_OPTIONS = [6, 12, 24, 48, 72, 168];

async function getSettings(env) {
  const s = await env.KV.get('settings', 'json').catch(() => null);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

/** 校验并钳制页面提交的设置，未知字段丢弃 */
function sanitizeSettings(body, cur) {
  const int = (v, min, max, def) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  const hours = int(body.checkIntervalHours, 6, 168, cur.checkIntervalHours);
  return {
    cronEnabled: typeof body.cronEnabled === 'boolean' ? body.cronEnabled : cur.cronEnabled,
    checkIntervalHours: INTERVAL_OPTIONS.includes(hours) ? hours : cur.checkIntervalHours,
    cronBatch: int(body.cronBatch, 1, 5, cur.cronBatch),
    autoLoadContent: typeof body.autoLoadContent === 'boolean' ? body.autoLoadContent : cur.autoLoadContent,
    inactiveDays: int(body.inactiveDays, 1, 3650, cur.inactiveDays),
  };
}

/**
 * Cron 每小时触发一次，但只检查"距上次检查超过间隔"的账号，按最久未检查优先，
 * 每次最多 cronBatch 个。关闭巡检时不访问任何 Emby 服务器。
 */
async function runScheduledCheck(env) {
  const settings = await getSettings(env);
  if (!settings.cronEnabled) return;
  const ids = JSON.parse((await env.KV.get('index:accounts')) || '[]');
  if (!ids.length) return;
  const accounts = (await Promise.all(ids.map(id => env.KV.get(`acct:${id}`, 'json')))).filter(Boolean);
  const checkedAt = a => Date.parse(a.health && a.health.checkedAt) || 0;
  const cutoff = Date.now() - settings.checkIntervalHours * 3600 * 1000;
  const due = accounts.filter(a => checkedAt(a) <= cutoff)
    .sort((a, b) => checkedAt(a) - checkedAt(b))
    .slice(0, settings.cronBatch);

  const alerts = [];
  for (const account of due) {
    const prev = { health: account.health, user: account.user };
    try {
      await refreshAccount(env, account);
    } catch (e) {
      if (isSubrequestLimit(e)) break; // 额度用完，剩下的留给下一轮，不算失败
    }
    await env.KV.put(`acct:${account.id}`, JSON.stringify(account));
    const msg = healthAlert(prev, account);
    if (msg) alerts.push(msg);
  }
  if (alerts.length) {
    try { await notify(env, 'Emby 账号巡检', alerts.join('\n\n')); } catch (e) { console.error('通知发送失败', e.message); }
  }
}

/** 返回给前端时去掉密码和 token */
function safeAccount(a) {
  const { token, ...rest } = a;
  return { ...rest, lines: (a.lines || []).map(l => ({ ...l, password: '' })) };
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

    // 临时诊断页：SenPlayer 导入格式排查（无敏感数据，放在鉴权前方便手机直接打开）
    if (path === '/import-debug') {
      return new Response(DEBUG_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // 静态页面
    if (path === '/' || path === '/index.html') {
      return new Response(HTML_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return new Response('Not Found', { status: 404 });
  },

  // Cron Trigger：定时巡检（频率见 wrangler.toml 的 [triggers]）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env));
  },
};

async function handleApi(request, env, url, path) {
  const listKey = 'index:accounts';

  // 账号列表
  if (path === '/api/accounts' && request.method === 'GET') {
    const ids = JSON.parse((await env.KV.get(listKey)) || '[]');
    const accounts = await Promise.all(ids.map(id => env.KV.get(`acct:${id}`, 'json')));
    // 返回时隐藏密码字段
    return json(accounts.filter(Boolean).map(safeAccount));
  }

  // 面板设置
  if (path === '/api/settings' && (request.method === 'GET' || request.method === 'PUT')) {
    let settings = await getSettings(env);
    if (request.method === 'PUT') {
      settings = sanitizeSettings(await request.json(), settings);
      await env.KV.put('settings', JSON.stringify(settings));
    }
    return json({ ...settings, notify: !!((env.TG_BOT_TOKEN && env.TG_CHAT_ID) || env.BARK_URL) });
  }

  // 发送测试通知
  if (path === '/api/notify/test' && request.method === 'POST') {
    const r = await notify(env, 'Emby 账号管理器', '这是一条测试通知，收到说明配置正确。');
    if (!r.sent) return json({ error: '未配置通知渠道（TG_BOT_TOKEN + TG_CHAT_ID 或 BARK_URL）' }, 400);
    return json({ ok: true, sent: r.sent });
  }

  // 添加账号
  if (path === '/api/accounts' && request.method === 'POST') {
    const body = await request.json();
    const lines = (body.lines || []).filter(l => l.host && l.username);
    if (lines.length === 0) return json({ error: '至少需要一条有效线路（host + username）' }, 400);

    const id = crypto.randomUUID();
    const account = await encryptAccountLines(env, {
      id,
      name: body.name || lines[0].username,
      note: body.note || '',
      lines: lines.map(l => ({ ...l, password: l.password || '' })),
      counts: {},
      lastWatchedAt: null,
      lastWatchedName: '',
    });
    // 测速并逐条登录，成功一条即可保存
    try {
      await refreshAccount(env, account, { measure: true, forceLogin: true });
    } catch (e) {
      return json({ error: `所有线路均登录失败 → ${e.message}` }, 400);
    }
    const ids = JSON.parse((await env.KV.get(listKey)) || '[]');
    ids.push(id);
    await env.KV.put(listKey, JSON.stringify(ids));
    await env.KV.put(`acct:${id}`, JSON.stringify(account));
    return json({ account: safeAccount(account) });
  }

  // 单个账号
  const m = path.match(/^\/api\/accounts\/([\w-]+)(\/(refresh|test|export|content))?$/);
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
      account.lines = (await encryptAccountLines(env, { lines: merged })).lines;
      if (!(account.activeLine < merged.length)) account.activeLine = 0;

      // 用新配置重新登录并刷新数据（失败不阻塞保存，编辑本身一定生效）
      let loginOk = true, loginErr;
      try {
        await refreshAccount(env, account, { measure: true, forceLogin: true });
      } catch (e) { loginOk = false; loginErr = e.message; }

      account.updatedAt = new Date().toISOString();
      await env.KV.put(`acct:${id}`, JSON.stringify(account));
      return json({ ok: true, loginOk, error: loginErr, account: safeAccount(account) });
    }

    // 刷新：测速选线路，复用/刷新会话，更新状态、观看时间与资源数量
    if (m[3] === 'refresh' && request.method === 'POST') {
      let err = null;
      try { await refreshAccount(env, account, { measure: true }); } catch (e) { err = e; }
      await env.KV.put(`acct:${id}`, JSON.stringify(account)); // 失败也记录 health / 延迟
      if (err) return json({ error: `刷新失败：${err.message}` }, 502);
      return json(safeAccount(account));
    }

    // 测试所有线路：并行登录，记录延迟
    if (m[3] === 'test' && request.method === 'POST') {
      const dec = await decryptAccountLines(env, account);
      const results = await Promise.all(dec.lines.map(async line => {
        const t0 = Date.now();
        try {
          await loginEmby(line, account.client);
          return { name: line.name || line.host, ok: true, ms: Date.now() - t0 };
        } catch (e) {
          return { name: line.name || line.host, ok: false, error: e.message };
        }
      }));
      return json(results);
    }

    // 详情页实时内容
    if (m[3] === 'content' && request.method === 'GET') {
      return json(await withSession(env, account, fetchContent));
    }

    // 导出账号凭据：用于前端生成播放器一键导入链接（受面板密码保护，密码明文仅此处下发）
    if (m[3] === 'export' && request.method === 'GET') {
      const dec = await decryptAccountLines(env, account);
      return json({
        name: account.name,
        note: account.note || '',
        lines: dec.lines.map(l => ({
          name: l.name || '', host: l.host, path: l.path || '', port: l.port || '',
          https: !!l.https, username: l.username || '', password: l.password || '',
        })),
      });
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
  [hidden] { display: none !important; }
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
  .top-btns { display: flex; gap: 10px; align-items: center; }
  .head-balance { width: 52px; display: inline-block; }
  .sortrow { width: 100%; background: none; border: 0; font: inherit; color: inherit; cursor: pointer; text-align: left; padding: 4px 14px; }
  .sortrow .row-label { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
  .sortrow:active { background: var(--tint); }
  .sortstate { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; font-size: 14px; color: var(--accent); font-weight: 500; }
  .sortstate .ic16 { color: var(--accent); }
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
  .chip.bad { color: var(--red); background: rgba(255,59,48,.12); }
  .chip.warn { color: #ff9500; background: rgba(255,149,0,.13); }
  .chip.info { color: var(--accent); background: var(--tint); }
  .ilist .row { min-height: 44px; padding: 7px 14px; }
  .ilist .im { flex: 1; min-width: 0; }
  .ilist .im b { display: block; font-size: 14.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ilist .im i { display: block; font-style: normal; font-size: 12.5px; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ilist .ir { flex-shrink: 0; font-size: 12.5px; color: var(--text2); }
  .ilist .empty1 { color: var(--text3); font-size: 13.5px; }
  .row-label.wide { width: auto; flex-shrink: 0; }
  select.ipt { appearance: none; -webkit-appearance: none; cursor: pointer; direction: rtl; }
  .lbadge { font-size: 11px; font-weight: 600; color: var(--accent); background: var(--tint); border-radius: 999px; padding: 1px 7px; margin-right: 4px; }
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

  .applist { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .appchip {
    display: flex; align-items: center; gap: 10px; text-align: left;
    padding: 9px 11px; border: 1px solid var(--sep); border-radius: var(--r-md);
    background: var(--card); color: var(--text); backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
    transition: transform .12s ease-out, border-color .2s, background .2s;
    -webkit-tap-highlight-color: transparent;
  }
  .appchip:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--sep)); }
  .appchip:active { transform: scale(.96); }
  .appavatar {
    width: 34px; height: 34px; border-radius: 9px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 15px; font-weight: 700;
  }
  .appmeta { min-width: 0; display: flex; flex-direction: column; }
  .appmeta b { font-size: 14px; font-weight: 600; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .appmeta i { font-style: normal; font-size: 11.5px; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
    <div class="top-btns">
      <button class="btn tint sq" id="btnSettings" aria-label="设置"></button>
      <button class="btn tint" id="btnSort" aria-label="排序方式"></button>
      <button class="btn primary" id="btnAdd"></button>
    </div>
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

<div class="overlay" id="sortOverlay" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sortTitle">
    <header class="sheet-head">
      <button class="btn ghost" id="btnSortClose">关闭</button>
      <h2 id="sortTitle">排序方式</h2>
      <span class="head-balance"></span>
    </header>
    <div class="sheet-body">
      <div class="group" id="sortList"></div>
      <p class="hint" style="margin-top:10px">点其他项切换排序维度；再点当前项切换正序/倒序。无数据的账户始终排在最后。</p>
    </div>
  </div>
</div>

<div class="overlay" id="settingsOverlay" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
    <header class="sheet-head">
      <button class="btn ghost" id="btnSettingsCancel">取消</button>
      <h2 id="settingsTitle">设置</h2>
      <button class="btn primary" id="btnSettingsSave">保存</button>
    </header>
    <div class="sheet-body">
      <h3 class="sec">自动巡检</h3>
      <div class="group">
        <div class="row"><span class="row-label wide">启用自动巡检</span><label class="switch"><input type="checkbox" id="s_cron"></label></div>
        <div class="row"><span class="row-label wide">每个账号间隔</span><select class="ipt" id="s_interval">
          <option value="6">6 小时</option><option value="12">12 小时</option><option value="24">1 天</option>
          <option value="48">2 天</option><option value="72">3 天</option><option value="168">7 天</option>
        </select></div>
        <div class="row"><span class="row-label wide">每次最多检查</span><select class="ipt" id="s_batch">
          <option value="1">1 个账号</option><option value="2">2 个账号</option><option value="3">3 个账号</option>
          <option value="4">4 个账号</option><option value="5">5 个账号</option>
        </select></div>
      </div>
      <p class="hint">巡检每小时触发一次，但只检查距上次检查超过间隔的账号（手动刷新也算一次检查），优先复用已保存的 token，不会重复登录。每个账号每次巡检约 4~5 个请求。关闭后不会自动访问任何 Emby 服务器。</p>
      <h3 class="sec">通知</h3>
      <div class="group">
        <div class="row"><span class="row-label wide">通知渠道</span><span class="ipt" id="s_notify" style="color:var(--text2)"></span></div>
      </div>
      <p class="hint">在 Worker 环境变量中配置 TG_BOT_TOKEN + TG_CHAT_ID 或 BARK_URL。只在账号失效、恢复、被禁用时推送。</p>
      <div class="sheet-actions" style="margin-top:12px"><button class="btn tint" id="btnNotifyTest">发送测试通知</button></div>
      <h3 class="sec">详情页</h3>
      <div class="group">
        <div class="row"><span class="row-label wide">自动加载实时内容</span><label class="switch"><input type="checkbox" id="s_autoload"></label></div>
        <div class="row"><span class="row-label wide">未观看提醒（天）</span><input class="ipt" id="s_inactive" inputmode="numeric"></div>
      </div>
      <p class="hint">实时内容包括在线会话、继续观看、下一集等，每次加载会向 Emby 发出 6 个请求，结果在本页缓存 5 分钟。关闭自动加载时，需在详情页手动点击加载。</p>
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
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  import: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  sort: '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  skip: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>',
  sparkle: '<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2Z"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>'
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

// ---------- 播放器一键导入 ----------
// 格式来源：各 App 官方文档 + 社区开源实现交叉验证（timjuly/libra、Aetrix-Emby-Portal）。
// Infuse / Fileball / AfuseKt / Yamby 已查证不支持链接导入，用复制兜底。
function lineUrl(l) {
  return (l.https ? 'https://' : 'http://') + l.host + (l.port ? ':' + l.port : '') + (l.path || '');
}
function enc(s) { return encodeURIComponent(s || ''); }
function b64url(s) {
  var bin = '';
  new TextEncoder().encode(s).forEach(function(b) { bin += String.fromCharCode(b); });
  return btoa(bin).split('+').join('-').split('/').join('_').split('=').join('');
}

function hostParams(l, p) {
  p.set('scheme', l.https ? 'https' : 'http');
  p.set('host', l.host);
  p.set('port', String(l.port || (l.https ? 443 : 80)));
}
function lineParams(a, p) {
  for (var i = 1; i < a.lines.length; i++) {
    p.set('line' + i, lineUrl(a.lines[i]));
    p.set('line' + i + 'title', a.lines[i].name || ('线路' + (i + 1)));
  }
}
function credParams(l, p) {
  p.set('username', l.username);
  if (l.password) p.set('password', l.password);
}

var IMPORT_APPS = [
  { id: 'senplayer', name: 'SenPlayer', plat: 'iOS · Mac · TV', color: '#ff9500',
    build: function(a) {
      var p = new URLSearchParams(); var m = a.lines[0];
      p.set('type', 'emby'); p.set('name', a.name); if (a.note) p.set('note', a.note);
      p.set('address', lineUrl(m)); credParams(m, p);
      for (var i = 1; i < a.lines.length; i++) {
        p.set('address' + i, lineUrl(a.lines[i]));
        p.set('address' + i + 'name', a.lines[i].name || ('线路' + (i + 1)));
      }
      return 'senplayer://importserver?' + p.toString();
    } },
  { id: 'vidhub', name: 'VidHub', plat: '全平台', color: '#0a84ff',
    build: function(a) {
      var p = new URLSearchParams(); var m = a.lines[0];
      p.set('type', 'emby'); p.set('title', a.name); hostParams(m, p); credParams(m, p); lineParams(a, p);
      return 'vidhub://import?' + p.toString();
    } },
  { id: 'rex', name: 'Rex', plat: 'Android', color: '#5e5ce6',
    build: function(a) {
      var p = new URLSearchParams(); var m = a.lines[0];
      p.set('type', 'emby'); p.set('title', a.name); hostParams(m, p); credParams(m, p); lineParams(a, p);
      return 'rex://import?' + p.toString();
    } },
  { id: 'hills', name: 'Hills', plat: 'Android · Windows', color: '#34c759',
    build: function(a) {
      var p = new URLSearchParams(); var m = a.lines[0];
      p.set('type', 'emby'); p.set('title', a.name); hostParams(m, p); credParams(m, p); lineParams(a, p);
      return 'hills://import?' + p.toString();
    } },
  { id: 'forward', name: 'Forward', plat: 'iOS · TV', color: '#ff2d55',
    build: function(a) {
      var p = new URLSearchParams(); var m = a.lines[0];
      p.set('type', 'emby'); p.set('title', a.name); hostParams(m, p); credParams(m, p); lineParams(a, p);
      return 'forward://import?' + p.toString();
    } },
  { id: 'oopsplayer', name: 'OopsPlayer', plat: 'iOS', color: '#30b0c7',
    build: function(a) {
      var p = new URLSearchParams(); var m = a.lines[0];
      p.set('type', 'emby'); p.set('name', a.name);
      p.set('address', lineUrl(m)); credParams(m, p);
      for (var i = 1; i < a.lines.length; i++) {
        p.set('address' + i, lineUrl(a.lines[i]));
        p.set('address' + i + 'name', a.lines[i].name || ('线路' + (i + 1)));
      }
      return 'oopsplayer://importserver?' + p.toString();
    } },
  { id: 'eplayerx', name: 'EplayerX', plat: 'iOS · Mac', color: '#af52de',
    build: function(a) {
      var p = new URLSearchParams(); var m = a.lines[0];
      p.set('type', 'emby'); p.set('href', lineUrl(m)); p.set('name', a.name); if (a.note) p.set('remark', a.note);
      credParams(m, p);
      if (a.lines.length > 1) {
        p.set('backupHref', a.lines.slice(1).map(function(l) { return lineUrl(l) + ';' + (l.name || ''); }).join(','));
      }
      return 'eplayerx://add-or-update?' + p.toString();
    } },
  { id: 'rodelplayer', name: '小幻影视', plat: 'Windows', color: '#8e8e93',
    build: function(a) {
      var p = new URLSearchParams(); var m = a.lines[0];
      p.set('type', 'emby'); p.set('title', a.name); hostParams(m, p);
      if (m.path) p.set('path', m.path);
      credParams(m, p); lineParams(a, p);
      return 'rodelplayer://import?' + p.toString();
    } },
  { id: 'libra', name: 'Libra', plat: '多平台', color: '#6e6e73',
    build: function(a) {
      var m = a.lines[0];
      var data = {
        type: 'emby', name: a.name, note: a.note,
        credentials: { username: m.username, password: m.password },
        primary: { url: lineUrl(m), name: m.name || '主线路' },
        alternates: a.lines.slice(1).map(function(l) { return { url: lineUrl(l), name: l.name || '' }; })
      };
      return 'libra://import/server?v=1&data=' + b64url(JSON.stringify(data));
    } }
];

var NO_IMPORT_APPS = 'Infuse / Fileball / AfuseKt / Yamby';

function importSectionHtml(a) {
  var chips = IMPORT_APPS.map(function(app) {
    return '<button class="appchip" data-action="import" data-app="' + app.id + '" data-id="' + a.id + '">' +
      '<span class="appavatar" style="background:' + app.color + '">' + esc(app.name.charAt(0)) + '</span>' +
      '<span class="appmeta"><b>' + esc(app.name) + '</b><i>' + esc(app.plat) + '</i></span>' +
    '</button>';
  }).join('');
  return '<h3 class="sec">一键导入到播放器</h3>' +
    '<div class="applist">' + chips + '</div>' +
    '<p class="hint">点击唤起对应 App 完成导入（需已安装）；含密码的链接仅在本机传递。' +
    esc(NO_IMPORT_APPS) + ' 暂不支持链接导入，可复制信息后手动添加。</p>' +
    '<div class="sheet-actions" style="margin-top:12px">' +
      '<button class="btn tint" data-action="copyinfo" data-id="' + a.id + '">' + ic('copy', 'ic16') + '复制服务器信息</button>' +
    '</div>';
}

var ACCOUNTS = [];
var SETTINGS = { cronEnabled: false, checkIntervalHours: 24, cronBatch: 3, autoLoadContent: false, inactiveDays: 30, notify: false };
var editingId = null;

// ---------- 状态 ----------
function daysSince(ts) { return ts ? Math.floor((Date.now() - new Date(ts).getTime()) / 86400000) : null; }

// 同一 ServerId 的其他账户（多个账户其实是同一台服务器）
function sameServer(a) {
  if (!a.serverId) return [];
  return ACCOUNTS.filter(function(x) { return x.id !== a.id && x.serverId === a.serverId; });
}

// 卡片上的状态提示：登录失败 / 已禁用 / N 天未观看 / 同服
function statusChips(a) {
  var out = [];
  if (a.health && a.health.ok === false) out.push('<span class="chip bad" title="' + esc(a.health.error) + '">' + ic('alert') + '登录失败</span>');
  if (a.user && a.user.isDisabled) out.push('<span class="chip bad">' + ic('alert') + '已禁用</span>');
  // 用最近观看时间判断活跃度：面板自己登录也会刷新 Emby 的 LastActivityDate，那个字段不可信
  var d = daysSince(a.lastWatchedAt);
  if (d !== null && d >= SETTINGS.inactiveDays) out.push('<span class="chip warn">' + ic('clock') + d + ' 天未观看</span>');
  var same = sameServer(a);
  if (same.length) out.push('<span class="chip info" title="与 ' + esc(same.map(function(x) { return x.name; }).join('、')) + ' 同一服务器">' + ic('server') + '同服 ×' + (same.length + 1) + '</span>');
  return out;
}

// ---------- 排序 ----------
var SORT_DEFS = [
  ['recent', '最近观看', 'clock', 'desc'],
  ['movie', '电影', 'film', 'desc'],
  ['series', '剧集', 'tv', 'desc'],
  ['episode', '集数', 'layers', 'desc'],
  ['song', '歌曲', 'music', 'desc'],
  ['album', '专辑', 'disc', 'desc'],
  ['book', '图书', 'book', 'desc'],
  ['name', '名称', 'server', 'asc']
];
var SORT = (function() {
  try {
    var s = JSON.parse(localStorage.getItem('emby-sort') || 'null');
    if (s && s.key && (s.dir === 'asc' || s.dir === 'desc')) return s;
  } catch (_) {}
  return { key: 'recent', dir: 'desc' };
})();
function saveSort() { try { localStorage.setItem('emby-sort', JSON.stringify(SORT)); } catch (_) {} }

function sortVal(a, key) {
  if (key === 'name') return String(a.name || '');
  if (key === 'recent') return a.lastWatchedAt ? new Date(a.lastWatchedAt).getTime() : null;
  var v = (a.counts || {})[key];
  return (v === undefined || v === null) ? null : v;
}
function sortAccounts(list) {
  var mul = SORT.dir === 'asc' ? 1 : -1;
  var sec = function(x) { return Date.parse(x.lastWatchedAt) || 0; };
  return list.slice().sort(function(a, b) {
    var va = sortVal(a, SORT.key), vb = sortVal(b, SORT.key);
    if (SORT.key === 'name') return String(va).localeCompare(String(vb), 'zh-Hans-CN') * mul;
    if (va === null && vb === null) return sec(b) - sec(a);
    if (va === null) return 1;  // 无数据始终排最后
    if (vb === null) return -1;
    if (va === vb) return sec(b) - sec(a);  // 并列时按最近观看
    return (va - vb) * mul;
  });
}
function sortDef(key) {
  for (var i = 0; i < SORT_DEFS.length; i++) if (SORT_DEFS[i][0] === key) return SORT_DEFS[i];
  return null;
}
function dirLabel(key, dir) {
  if (key === 'recent') return dir === 'desc' ? '从新到旧' : '从旧到新';
  if (key === 'name') return dir === 'asc' ? 'A 到 Z' : 'Z 到 A';
  return dir === 'desc' ? '从多到少' : '从少到多';
}
function updateSortBtn() {
  var d = sortDef(SORT.key);
  $('#btnSort').innerHTML = ic('sort', 'ic16') + (d ? d[1] : '排序') + ' ' + (SORT.dir === 'desc' ? '↓' : '↑');
}
function renderSortMenu() {
  $('#sortList').innerHTML = SORT_DEFS.map(function(d) {
    var on = SORT.key === d[0];
    return '<button class="row sortrow" data-skey="' + d[0] + '">' +
      '<span class="row-label">' + ic(d[2], 'ic16') + d[1] + '</span>' +
      (on ? '<span class="sortstate">' + dirLabel(d[0], SORT.dir) + ic('check', 'ic16') + '</span>' : '') +
    '</button>';
  }).join('');
}
function openSort() { renderSortMenu(); openOverlay($('#sortOverlay')); }
function pickSort(key) {
  if (SORT.key === key) {
    SORT.dir = SORT.dir === 'asc' ? 'desc' : 'asc';
    saveSort(); renderSortMenu(); render(); updateSortBtn();
    return;  // 切方向时保持菜单打开，方便确认状态
  }
  var d = sortDef(key);
  SORT.key = key; SORT.dir = d ? d[3] : 'desc';
  saveSort(); render(); updateSortBtn();
  closeOverlay($('#sortOverlay'));
}

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
  el.innerHTML = sortAccounts(ACCOUNTS).map(cardHtml).join('');
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
  var status = statusChips(a);
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
    (status.length ? '<div class="chips">' + status.join('') + '</div>' : '') +
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
  var stats = a.lineStats || [];
  var lineRows = (a.lines || []).map(function(l, i) {
    return '<div class="row"><span class="row-label">' + esc(l.name || ('线路 ' + (i + 1))) + '</span>' +
      '<span class="ipt" style="color:var(--text2)">' + esc((l.https ? 'https://' : 'http://') + l.host + (l.port ? ':' + l.port : '') + (l.path || '')) + '</span>' +
      (a.activeLine === i ? '<span class="lbadge">当前</span>' : '') +
      lineStateHtml(stats[i]) + '</div>';
  }).join('');
  $('#d_body').innerHTML =
    serverSectionHtml(a) +
    '<h3 class="sec">最近观看</h3>' + watch +
    '<h3 class="sec">资源数量</h3><div class="tiles">' + tiles + '</div>' +
    '<div id="d_live"></div>' +
    '<h3 class="sec">线路</h3><div class="group linestatus">' + lineRows + '</div>' +
    '<p class="hint">延迟为刷新时从 Cloudflare 节点测得，仅用于面板选择线路，和你本地的网络体验不一定一致。「测试线路」会逐条登录验证。</p>' +
    importSectionHtml(a) +
    '<div class="sheet-actions">' +
      '<button class="btn primary" data-action="refresh" data-id="' + a.id + '">' + ic('refresh', 'ic16') + '刷新数据</button>' +
      '<button class="btn tint" data-action="test" data-id="' + a.id + '">' + ic('activity', 'ic16') + '测试线路</button>' +
      '<button class="btn tint" data-action="edit" data-id="' + a.id + '">' + ic('pencil', 'ic16') + '编辑</button>' +
    '</div>';
  openOverlay($('#detailOverlay'));
  showLive(a.id);
}

function lineStateHtml(s) {
  if (!s) return '<span class="lstate unknown"><span class="dot2"></span>未测试</span>';
  if (s.ok) return '<span class="lstate ok"><span class="dot2"></span>' + (s.ms != null ? s.ms + ' ms' : '可用') + '</span>';
  return '<span class="lstate bad" title="' + esc(s.error) + '"><span class="dot2"></span>' + esc(s.error || '不可用') + '</span>';
}

function serverSectionHtml(a) {
  var rows = [];
  var h = a.health;
  if (h) {
    rows.push(['状态', h.ok
      ? '<span class="lstate ok"><span class="dot2"></span>正常</span>'
      : '<span class="lstate bad"><span class="dot2"></span>登录失败</span>']);
  }
  if (a.user) rows.push(['账号', a.user.isDisabled ? '<span class="lstate bad"><span class="dot2"></span>已被禁用</span>' : '<span class="lstate ok"><span class="dot2"></span>启用中</span>']);
  if (a.server) {
    if (a.server.name) rows.push(['服务器', esc(a.server.name)]);
    if (a.server.version) rows.push(['版本', esc(a.server.version)]);
  }
  var same = sameServer(a);
  if (same.length) rows.push(['同服', esc(same.map(function(x) { return x.name; }).join('、'))]);
  if (h && h.checkedAt) rows.push(['检查于', esc(relTime(h.checkedAt))]);
  if (!rows.length) return '';
  var html = '<h3 class="sec">状态</h3><div class="group">' + rows.map(function(r) {
    return '<div class="row"><span class="row-label">' + r[0] + '</span><span class="ipt" style="color:var(--text2)">' + r[1] + '</span></div>';
  }).join('') + '</div>';
  if (h && !h.ok && h.error) html += '<div class="formmsg"><div class="msg">' + esc(h.error) + '</div></div>';
  return html;
}

// ---------- 详情页实时内容 ----------
var LIVE_DEFS = [
  ['sessions', '在线会话', 'monitor'],
  ['resume', '继续观看', 'play'],
  ['nextUp', '下一集', 'skip'],
  ['latest', '最近入库', 'sparkle'],
  ['favorites', '收藏', 'heart'],
  ['views', '媒体库', 'folder']
];
var VIEW_TYPES = { movies: '电影', tvshows: '剧集', music: '音乐', books: '图书', homevideos: '家庭视频', musicvideos: 'MV', boxsets: '合集', playlists: '播放列表', photos: '照片' };
var liveSeq = 0;

function itemTitle(it) {
  if (it.type === 'Episode') {
    var se = (it.season != null ? 'S' + it.season : '') + (it.episode != null ? 'E' + it.episode : '');
    return { main: it.series || it.name, sub: [se, it.name].filter(Boolean).join(' · ') };
  }
  var t = { Movie: '电影', Series: '剧集', Audio: '歌曲', MusicAlbum: '专辑', Book: '图书' }[it.type] || it.type;
  return { main: it.name, sub: [t, it.year].filter(Boolean).join(' · ') };
}

function liveRow(main, sub, right) {
  return '<div class="row"><div class="im"><b>' + esc(main) + '</b>' + (sub ? '<i>' + esc(sub) + '</i>' : '') + '</div>' +
    (right ? '<span class="ir">' + esc(right) + '</span>' : '') + '</div>';
}

function liveRows(key, data) {
  if (key === 'views') {
    return data.map(function(v) { return liveRow(v.name, VIEW_TYPES[v.type] || v.type || ''); });
  }
  if (key === 'sessions') {
    return data.map(function(s) {
      var p = s.playing ? itemTitle(s.playing) : null;
      var main = (s.device || '未知设备') + (s.client ? ' · ' + s.client : '');
      var sub = p ? (s.paused ? '已暂停：' : '正在播放：') + p.main + (p.sub ? ' ' + p.sub : '') : '空闲';
      return liveRow(main, sub + (s.ip ? '  ' + s.ip : ''), s.lastActivity ? relTime(s.lastActivity) : '');
    });
  }
  return data.map(function(it) {
    var t = itemTitle(it);
    var right = it.percent ? it.percent + '%' : (key === 'latest' && it.childCount > 1 ? it.childCount + ' 项' : '');
    return liveRow(t.main, t.sub, right);
  });
}

// 实时内容缓存：同一账户 5 分钟内重复打开详情页、刷新后重新渲染都不再请求 Emby
var LIVE_CACHE = {};
var LIVE_TTL = 5 * 60 * 1000;

function liveButtonHtml(id, label) {
  return '<div class="sheet-actions" style="margin-top:22px"><button class="btn tint" data-action="live" data-id="' + id + '">' +
    ic('refresh', 'ic16') + label + '</button></div>';
}

// 打开详情页时调用：有缓存用缓存；没有缓存且未开自动加载，只显示按钮
function showLive(id) {
  var c = LIVE_CACHE[id];
  if (c && Date.now() - c.at < LIVE_TTL) { renderLive(id, c.data, c.at); return; }
  if (SETTINGS.autoLoadContent) { loadLive(id, false); return; }
  $('#d_live').innerHTML = liveButtonHtml(id, '加载在线会话、继续观看等内容') +
    '<p class="hint">会向 Emby 服务器发出 6 个请求。可在设置中开启自动加载。</p>';
}

async function loadLive(id, force) {
  var c = LIVE_CACHE[id];
  if (!force && c && Date.now() - c.at < LIVE_TTL) { renderLive(id, c.data, c.at); return; }
  var seq = ++liveSeq;
  var box = $('#d_live');
  box.innerHTML = '<p class="hint">正在加载在线会话、继续观看等内容…</p>';
  try {
    var d = await api('/api/accounts/' + id + '/content');
    LIVE_CACHE[id] = { data: d, at: Date.now() };
    if (seq !== liveSeq || !box.isConnected) return; // 已切换到别的账户或重新渲染
    renderLive(id, d, LIVE_CACHE[id].at);
  } catch (e) {
    if (seq !== liveSeq || !box.isConnected) return;
    box.innerHTML = '<p class="hint">实时内容加载失败：' + esc(e.message) + '</p>' + liveButtonHtml(id, '重试');
  }
}

function renderLive(id, d, at) {
  $('#d_live').innerHTML = LIVE_DEFS.map(function(def) {
      var v = d[def[0]];
      var body;
      if (!v) return '';
      if (v.error) body = '<div class="row"><span class="empty1">获取失败：' + esc(v.error) + '</span></div>';
      else if (!v.length) body = '<div class="row"><span class="empty1">' + (def[0] === 'sessions' ? '当前没有其他设备在线' : '暂无') + '</span></div>';
      else body = liveRows(def[0], v).join('');
      return '<h3 class="sec">' + def[1] + '</h3><div class="group ilist">' + body + '</div>';
    }).join('') +
    '<p class="hint">获取于 ' + esc(relTime(at)) + '，5 分钟内重复打开使用缓存。</p>' +
    liveButtonHtml(id, '重新加载实时内容');
}

// ---------- 设置 ----------
async function openSettings() {
  try { SETTINGS = await api('/api/settings'); } catch (e) { toast('读取设置失败：' + e.message, 'err'); return; }
  $('#s_cron').checked = !!SETTINGS.cronEnabled;
  $('#s_interval').value = String(SETTINGS.checkIntervalHours);
  $('#s_batch').value = String(SETTINGS.cronBatch);
  $('#s_autoload').checked = !!SETTINGS.autoLoadContent;
  $('#s_inactive').value = String(SETTINGS.inactiveDays);
  $('#s_notify').textContent = SETTINGS.notify ? '已配置' : '未配置';
  openOverlay($('#settingsOverlay'));
}

async function saveSettings() {
  var btn = $('#btnSettingsSave');
  btn.disabled = true;
  try {
    SETTINGS = await api('/api/settings', { method: 'PUT', body: JSON.stringify({
      cronEnabled: $('#s_cron').checked,
      checkIntervalHours: Number($('#s_interval').value),
      cronBatch: Number($('#s_batch').value),
      autoLoadContent: $('#s_autoload').checked,
      inactiveDays: Number($('#s_inactive').value)
    }) });
    closeOverlay($('#settingsOverlay'));
    toast('设置已保存');
    render();
  } catch (e) { toast('保存失败：' + e.message, 'err'); }
  finally { btn.disabled = false; }
}

async function testNotify() {
  try {
    var r = await api('/api/notify/test', { method: 'POST' });
    toast('已发送到 ' + r.sent + ' 个渠道');
  } catch (e) { toast('发送失败：' + e.message, 'err'); }
}

async function testLines(id) {
  var a = ACCOUNTS.find(function(x) { return x.id === id; });
  if (!a) return;
  var marks = document.querySelectorAll('#d_body .linestatus .lstate');
  marks.forEach(function(m) { m.className = 'lstate unknown'; m.innerHTML = '<span class="dot2"></span>测试中'; });
  try {
    var results = await api('/api/accounts/' + id + '/test', { method: 'POST' });
    marks.forEach(function(m, i) {
      var r = results[i];
      if (!r) return;
      if (r.ok) { m.className = 'lstate ok'; m.innerHTML = '<span class="dot2"></span>可用 · 登录 ' + r.ms + ' ms'; }
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

// 这些应用的导入协议不支持路径参数，主线路带 path 时提醒手动补充
var PATH_DROP = { hills: 1, rex: 1, forward: 1, vidhub: 1 };

async function doImport(id, appId) {
  var app = null;
  for (var i = 0; i < IMPORT_APPS.length; i++) if (IMPORT_APPS[i].id === appId) app = IMPORT_APPS[i];
  if (!app) return;
  try {
    var a = await api('/api/accounts/' + id + '/export');
    if (!a.lines || !a.lines.length) { toast('没有可用线路', 'err'); return; }
    toast('正在打开 ' + app.name + '…若未安装请改用复制');
    window.location.href = app.build(a);
    var m = a.lines[0];
    if (m.path && PATH_DROP[app.id]) {
      setTimeout(function() {
        toast(app.name + ' 导入协议不含路径参数，主线路路径「' + m.path + '」请在 App 内手动补充', 'warn');
      }, 1200);
    }
  } catch (e) { toast('导入失败：' + e.message, 'err'); }
}

async function copyInfo(id) {
  var NL = String.fromCharCode(10);
  try {
    var a = await api('/api/accounts/' + id + '/export');
    var parts = ['Emby：' + a.name + (a.note ? '（' + a.note + '）' : '')];
    a.lines.forEach(function(l, i) {
      parts.push('线路' + (i + 1) + (l.name ? '「' + l.name + '」' : '') + '：' + lineUrl(l));
      parts.push('用户：' + l.username + (l.password ? '  密码：' + l.password : ''));
    });
    var text = parts.join(NL);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    toast('已复制服务器信息');
  } catch (e) { toast('复制失败：' + e.message, 'err'); }
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
    else if (action === 'import') doImport(id, act.getAttribute('data-app'));
    else if (action === 'copyinfo') copyInfo(id);
    else if (action === 'live') loadLive(id, true);
    else if (action === 'delline') { act.closest('.line').remove(); renumberLines(); }
    return;
  }
  if (e.target.closest('#btnAdd') || e.target.closest('#btnEmptyAdd')) { openAdd(); return; }
  if (e.target.closest('#btnSort')) { openSort(); return; }
  if (e.target.closest('#btnSettings')) { openSettings(); return; }
  if (e.target.closest('#btnSettingsCancel')) { closeOverlay($('#settingsOverlay')); return; }
  if (e.target.closest('#btnSettingsSave')) { saveSettings(); return; }
  if (e.target.closest('#btnNotifyTest')) { testNotify(); return; }
  if (e.target.closest('#btnSortClose')) { closeOverlay($('#sortOverlay')); return; }
  var srow = e.target.closest('[data-skey]');
  if (srow) { pickSort(srow.getAttribute('data-skey')); return; }
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
  $('#btnSettings').innerHTML = ic('gear', 'ic16');
  $('#btnAddLine').innerHTML = ic('plus', 'ic16') + '添加备用线路';
  updateSortBtn();
}
initChrome();
api('/api/settings').then(function(s) { SETTINGS = s; }).catch(function() {}).then(loadAccounts);
</script>
</body>
</html>
`;

// SenPlayer 导入格式诊断页（临时）
const DEBUG_PAGE = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SenPlayer 导入调试</title>
<style>
  body { font: 16px/1.6 -apple-system, system-ui, sans-serif; background: #f2f2f7; color: #1c1c1e; margin: 0; padding: 24px 16px 48px; }
  .wrap { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p.tip { background: #eef4ff; border-radius: 12px; padding: 12px 14px; font-size: 14px; color: #3a3a3c; margin: 0 0 4px; }
  .target { font-size: 14px; color: #6e6e73; margin: 10px 0 0; }
  .card { background: #fff; border-radius: 14px; padding: 14px 16px; margin: 12px 0; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  .card h2 { font-size: 16px; margin: 0 0 4px; }
  code { display: block; font: 12px/1.5 ui-monospace, Menlo, monospace; color: #6e6e73; word-break: break-all; background: #f2f2f7; border-radius: 8px; padding: 8px 10px; margin: 8px 0; }
  a.btn { display: block; text-align: center; background: #ff9500; color: #fff; text-decoration: none; border-radius: 10px; padding: 10px 0; font-weight: 600; }
  a.btn:active { opacity: .7; }
</style>
</head>
<body>
<div class="wrap">
<h1>SenPlayer 导入格式调试</h1>
<p class="tip">依次点下面每个按钮，SenPlayer 会弹出导入表单，对照四个字段：<b>主机</b> = test.inemby.us.ci，<b>端口</b> = 443，<b>路径</b> = 空，<b>https</b> = 开。全部正确的变体，把它的编号告诉我。每个变体名字不同（调试A/B/...），方便区分。</p>
<p class="target">正确目标：主机 test.inemby.us.ci · 端口 443 · 路径 空 · https 开</p>

<div class="card"><h2>A · 完整地址（现行格式，你已测过是错的）</h2>
<code>address=https://test.inemby.us.ci:443</code>
<a class="btn" href="senplayer://importserver?type=emby&amp;name=调试A&amp;address=https%3A%2F%2Ftest.inemby.us.ci%3A443&amp;username=test&amp;password=test">导入调试A</a></div>

<div class="card"><h2>B · 无协议带端口</h2>
<code>address=test.inemby.us.ci:443</code>
<a class="btn" href="senplayer://importserver?type=emby&amp;name=调试B&amp;address=test.inemby.us.ci%3A443&amp;username=test&amp;password=test">导入调试B</a></div>

<div class="card"><h2>C · 无协议 + 独立 port/https 参数</h2>
<code>address=test.inemby.us.ci &amp; port=443 &amp; https=true</code>
<a class="btn" href="senplayer://importserver?type=emby&amp;name=调试C&amp;address=test.inemby.us.ci&amp;port=443&amp;https=true&amp;username=test&amp;password=test">导入调试C</a></div>

<div class="card"><h2>D · 纯独立参数（VidHub 风格）</h2>
<code>scheme=https &amp; host=test.inemby.us.ci &amp; port=443 &amp; https=true</code>
<a class="btn" href="senplayer://importserver?type=emby&amp;name=调试D&amp;scheme=https&amp;host=test.inemby.us.ci&amp;port=443&amp;https=true&amp;username=test&amp;password=test">导入调试D</a></div>

<div class="card"><h2>E · 完整地址 + 独立参数组合</h2>
<code>address=https://test.inemby.us.ci:443 &amp; host=... &amp; port=443 &amp; https=true</code>
<a class="btn" href="senplayer://importserver?type=emby&amp;name=调试E&amp;address=https%3A%2F%2Ftest.inemby.us.ci%3A443&amp;host=test.inemby.us.ci&amp;port=443&amp;https=true&amp;username=test&amp;password=test">导入调试E</a></div>

<div class="card"><h2>F · 换参数名 url=</h2>
<code>url=https://test.inemby.us.ci:443</code>
<a class="btn" href="senplayer://importserver?type=emby&amp;name=调试F&amp;url=https%3A%2F%2Ftest.inemby.us.ci%3A443&amp;username=test&amp;password=test">导入调试F</a></div>

<div class="card"><h2>G · 现行格式 + 备用线路参数（排查备用参数是否干扰）</h2>
<code>address=... &amp; address1name=备用 &amp; address1=http://test.28.al</code>
<a class="btn" href="senplayer://importserver?type=emby&amp;name=调试G&amp;address=https%3A%2F%2Ftest.inemby.us.ci%3A443&amp;address1name=%E5%A4%87%E7%94%A8&amp;address1=http%3A%2F%2Ftest.28.al&amp;username=test&amp;password=test">导入调试G</a></div>

</div>
</body>
</html>`;
