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
  const proto = line.https ? 'https' : 'http';
  let base = `${proto}://${line.host}`;
  if (line.port) base += `:${line.port}`;
  if (line.path) base += line.path.startsWith('/') ? line.path : '/' + line.path;
  return base.replace(/\/+$/, '');
}

/** 调用 Emby API，超时 12 秒 */
async function embyFetch(baseUrl, path, options = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}${path}`, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 登录 Emby，返回 { userId, token, serverId }；失败抛错 */
async function loginEmby(line) {
  const base = buildBaseUrl(line);
  const url = `${base}/emby/Users/AuthenticateByName`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Emby-Authorization': `MediaBrowser Client="EmbyManager", Device="Manager", DeviceId="emby-manager-cf", Version="1.0"`,
      },
      body: JSON.stringify({ Username: line.username, Pw: line.password || '' }),
    });
  } catch (e) {
    throw new Error(`无法连接服务器 ${base}（超时或网络错误）`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('用户名或密码错误');
    throw new Error(`登录失败：HTTP ${res.status}`);
  }
  const data = await res.json();
  return { userId: data.User.Id, token: data.AccessToken, serverId: data.ServerId };
}

/** 拉取资源数量统计（Items/Counts） */
async function fetchCounts(baseUrl, token) {
  const res = await embyFetch(baseUrl, `/emby/Items/Counts?api_key=${encodeURIComponent(token)}`);
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

/** 拉取最近一次观看时间：取当前用户的播放历史最新一条 */
async function fetchLastPlayed(baseUrl, token, userId) {
  const path = `/emby/Users/${encodeURIComponent(userId)}/PlayedItems/Latest?Limit=1&api_key=${encodeURIComponent(token)}`;
  let res = await embyFetch(baseUrl, path);
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
  res = await embyFetch(baseUrl, fallback);
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
    try { counts = await fetchCounts(base, main.token); } catch (_) {}
    try { lastPlayed = await fetchLastPlayed(base, main.token, main.userId); } catch (_) {}

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
  const m = path.match(/^\/api\/accounts\/([\w-]+)$/);
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

    // 刷新：重新登录可用线路，更新观看时间与资源数量
    if (path === `/api/accounts/${id}/refresh` && request.method === 'POST') {
      const dec = await decryptAccountLines(env, account);
      let result = null, lastErr = null;
      for (const line of dec.lines) {
        try {
          const login = await loginEmby(line);
          const base = buildBaseUrl(line);
          let counts = null, lastPlayed = {};
          try { counts = await fetchCounts(base, login.token); } catch (_) {}
          try { lastPlayed = await fetchLastPlayed(base, login.token, login.userId); } catch (_) {}
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
    if (path === `/api/accounts/${id}/test` && request.method === 'POST') {
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Emby 账号管理器</title>
<style>
  :root {
    --bg: #f5f6f8; --card: #fff; --border: #e5e7eb;
    --text: #111827; --muted: #6b7280; --accent: #2563eb;
    --radius: 12px;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #111418; --card: #1a1f26; --border: #2a313b; --text: #e5e7eb; --muted: #9ca3af; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .container { max-width: 1080px; margin: 0 auto; padding: 24px 16px 60px; }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
  h1 { font-size: 22px; margin: 0; }
  button { font: inherit; cursor: pointer; border: 1px solid var(--border); background: var(--card); color: var(--text); border-radius: 8px; padding: 8px 14px; }
  button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  button.danger { color: #dc2626; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; transition: box-shadow .15s; }
  .card:hover { box-shadow: 0 4px 16px rgba(0,0,0,.08); }
  .card h3 { margin: 0 0 4px; font-size: 16px; }
  .card .note { color: var(--muted); font-size: 13px; margin-bottom: 10px; }
  .meta { font-size: 13px; color: var(--muted); display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  .badge { display: inline-block; font-size: 12px; background: rgba(37,99,235,.1); color: var(--accent); padding: 2px 8px; border-radius: 999px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .actions button { padding: 6px 10px; font-size: 13px; }
  dialog { border: none; border-radius: var(--radius); background: var(--card); color: var(--text); padding: 0; max-width: 560px; width: calc(100% - 32px); }
  dialog::backdrop { background: rgba(0,0,0,.4); }
  .dlg-body { padding: 20px; max-height: 85vh; overflow: auto; }
  .dlg-body h2 { margin: 0 0 16px; font-size: 18px; }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
  .field input { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; }
  .line-box { border: 1px dashed var(--border); border-radius: 8px; padding: 12px; margin-bottom: 10px; }
  .line-box h4 { margin: 0 0 8px; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .hint { font-size: 12px; color: var(--muted); }
  .detail-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px,1fr)); gap: 10px; margin: 12px 0; }
  .stat { background: var(--bg); border-radius: 8px; padding: 10px; text-align: center; }
  .stat b { display: block; font-size: 20px; }
  .stat span { font-size: 12px; color: var(--muted); }
  .line-status { font-size: 13px; padding: 6px 0; border-bottom: 1px solid var(--border); display:flex; justify-content: space-between; }
  .empty { text-align: center; color: var(--muted); padding: 60px 0; }
  .msg { padding: 8px 12px; border-radius: 8px; font-size: 13px; margin: 8px 0; }
  .msg.ok { background: rgba(34,197,94,.12); color: #16a34a; }
  .msg.err { background: rgba(220,38,38,.1); color: #dc2626; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>🎬 Emby 账号管理器</h1>
    <button class="primary" onclick="openAdd()">＋ 添加账号</button>
  </header>
  <div id="msg"></div>
  <div id="list" class="grid"></div>
</div>

<dialog id="addDlg">
  <div class="dlg-body">
    <h2>添加 Emby 账号</h2>
    <div class="field"><label>名称（可选）</label><input id="f_name" placeholder="例如：主号"></div>
    <div class="field"><label>备注（可选）</label><input id="f_note" placeholder="例如：年费会员"></div>

    <div id="lines"></div>
    <button type="button" onclick="addLine()">＋ 添加备用线路</button>

    <div id="addMsg"></div>
    <div style="display:flex;gap:8px;margin-top:16px;">
      <button class="primary" id="btnSave" onclick="saveAccount()">保存并验证</button>
      <button onclick="document.getElementById('addDlg').close()">取消</button>
    </div>
  </div>
</dialog>

<dialog id="detailDlg">
  <div class="dlg-body" id="detailBody"></div>
</dialog>

<script>
const lineTpl = () => ({
  name: '', host: '', path: '', port: '', https: false, username: '', password: ''
});

let ACCOUNTS = [];

async function api(path, opts = {}) {
  const pwd = sessionStorage.getItem('panelPwd') || '';
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(path + sep + 'pwd=' + encodeURIComponent(pwd), {
    headers: { 'X-Panel-Password': pwd, 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function showMsg(text, ok = true) {
  const el = document.getElementById('msg');
  el.innerHTML = '<div class="msg ' + (ok ? 'ok' : 'err') + '">' + esc(text) + '</div>';
  setTimeout(() => el.innerHTML = '', 4000);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function fmtTime(ts) {
  if (!ts) return '暂无观看记录';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function loadAccounts() {
  try {
    ACCOUNTS = await api('/api/accounts');
    render();
  } catch (e) { showMsg('加载失败：' + e.message, false); }
}

function render() {
  const el = document.getElementById('list');
  if (!ACCOUNTS.length) { el.innerHTML = '<div class="empty">还没有账号，点击右上角添加</div>'; return; }
  el.innerHTML = ACCOUNTS.map(a => {
    const lines = (a.lines || []).map(l => esc(l.name || l.host)).join(' / ');
    return '<div class="card" onclick="openDetail(\\'' + a.id + '\\')">' +
      '<h3>' + esc(a.name) + '</h3>' +
      (a.note ? '<div class="note">' + esc(a.note) + '</div>' : '') +
      '<div class="meta">' +
        '<span>🕐 最近观看：' + fmtTime(a.lastWatchedAt) + '</span>' +
        (a.lastWatchedName ? '<span>📺 ' + esc(a.lastWatchedName) + '</span>' : '') +
        '<span>🛰 线路（' + (a.lines || []).length + '）：' + lines + '</span>' +
      '</div>' +
      '<div class="actions" onclick="event.stopPropagation()">' +
        '<button class="primary" onclick="refresh(\\'' + a.id + '\\')">刷新</button>' +
        '<button onclick="openDetail(\\'' + a.id + '\\')">详情</button>' +
        '<button class="danger" onclick="del(\\'' + a.id + '\\')">删除</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function addLine(data) {
  const box = document.createElement('div');
  box.className = 'line-box';
  const idx = document.querySelectorAll('#lines .line-box').length;
  const d = data || lineTpl();
  box.innerHTML =
    '<h4>线路 ' + (idx + 1) + (idx === 0 ? '（主线路）' : '') + ' <button type="button" onclick="this.closest(\\'.line-box\\').remove()">✕</button></h4>' +
    '<div class="field"><label>线路名称（可选）</label><input class="l_name" placeholder="例如：移动线路" value="' + esc(d.name) + '"></div>' +
    '<div class="row2">' +
      '<div class="field"><label>主机 Host（必填）</label><input class="l_host" placeholder="例如：emby.example.com" value="' + esc(d.host) + '"></div>' +
      '<div class="field"><label>端口 Port（可选）</label><input class="l_port" placeholder="默认 80/443" value="' + esc(d.port) + '"></div>' +
    '</div>' +
    '<div class="field"><label>路径 Path（可选）</label><input class="l_path" placeholder="例如：/emby" value="' + esc(d.path) + '"></div>' +
    '<div class="row2">' +
      '<div class="field"><label>用户名（必填）</label><input class="l_user" value="' + esc(d.username) + '"></div>' +
      '<div class="field"><label>密码</label><input class="l_pass" type="password" value="' + esc(d.password) + '"></div>' +
    '</div>' +
    '<label class="hint"><input type="checkbox" class="l_https" ' + (d.https ? 'checked' : '') + '> 使用 https</label>';
  document.getElementById('lines').appendChild(box);
}

function collectLines() {
  const lines = [];
  document.querySelectorAll('#lines .line-box').forEach(box => {
    const val = c => box.querySelector('.' + c).value.trim();
    lines.push({
      name: val('l_name'), host: val('l_host'), path: val('l_path'),
      port: val('l_port'), username: val('l_user'), password: val('l_pass'),
      https: box.querySelector('.l_https').checked,
    });
  });
  return lines;
}

function openAdd() {
  document.getElementById('lines').innerHTML = '';
  document.getElementById('addMsg').innerHTML = '';
  ['f_name','f_note'].forEach(id => document.getElementById(id).value = '');
  addLine();
  document.getElementById('addDlg').showModal();
}

async function saveAccount() {
  const btn = document.getElementById('btnSave');
  const msg = document.getElementById('addMsg');
  const lines = collectLines();
  if (!lines.some(l => l.host && l.username)) { msg.innerHTML = '<div class="msg err">至少填写一条线路的 Host 和用户名</div>'; return; }
  btn.disabled = true;
  msg.innerHTML = '<div class="msg ok">正在验证并保存…</div>';
  try {
    await api('/api/accounts', { method: 'POST', body: JSON.stringify({
      name: document.getElementById('f_name').value.trim(),
      note: document.getElementById('f_note').value.trim(),
      lines,
    })});
    document.getElementById('addDlg').close();
    showMsg('账号添加成功');
    await loadAccounts();
  } catch (e) {
    msg.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>';
  } finally { btn.disabled = false; }
}

async function refresh(id) {
  try {
    await api('/api/accounts/' + id + '/refresh', { method: 'POST' });
    showMsg('刷新成功');
    await loadAccounts();
  } catch (e) { showMsg('刷新失败：' + e.message, false); }
}

async function del(id) {
  if (!confirm('确定删除该账号？')) return;
  await api('/api/accounts/' + id, { method: 'DELETE' });
  showMsg('已删除');
  await loadAccounts();
}

async function openDetail(id) {
  const a = ACCOUNTS.find(x => x.id === id);
  if (!a) return;
  const body = document.getElementById('detailBody');
  const c = a.counts || {};
  const stat = (label, v) => '<div class="stat"><b>' + (v || 0) + '</b><span>' + label + '</span></div>';
  body.innerHTML =
    '<h2>' + esc(a.name) + '</h2>' +
    '<div class="meta">' +
      '<span>🕐 最近观看：' + fmtTime(a.lastWatchedAt) + (a.lastWatchedName ? ' · ' + esc(a.lastWatchedName) : '') + '</span>' +
      '<span>更新于：' + fmtTime(a.updatedAt) + '</span>' +
    '</div>' +
    '<h3 style="font-size:15px">资源数量</h3>' +
    '<div class="detail-grid">' +
      stat('电影', c.movie) + stat('剧集', c.series) + stat('集数', c.episode) +
      stat('歌曲', c.song) + stat('专辑', c.album) + stat('图书', c.book) +
    '</div>' +
    '<h3 style="font-size:15px">线路状态</h3>' +
    '<div id="lineStatus"><div class="hint">点击下方"测试线路"检查连通性</div></div>' +
    '<div style="display:flex;gap:8px;margin-top:16px;">' +
      '<button class="primary" onclick="refresh(\\'' + a.id + '\\')">刷新数据</button>' +
      '<button onclick="testLines(\\'' + a.id + '\\')">测试线路</button>' +
      '<button onclick="document.getElementById(\\'detailDlg\\').close()">关闭</button>' +
    '</div>';
  document.getElementById('detailDlg').showModal();
}

async function testLines(id) {
  const el = document.getElementById('lineStatus');
  el.innerHTML = '<div class="hint">测试中…</div>';
  try {
    const results = await api('/api/accounts/' + id + '/test', { method: 'POST' });
    el.innerHTML = results.map(r =>
      '<div class="line-status"><span>' + esc(r.name) + '</span>' +
      '<span style="color:' + (r.ok ? '#16a34a' : '#dc2626') + '">' + (r.ok ? '✓ 可用' : '✕ ' + esc(r.error || '失败')) + '</span></div>'
    ).join('');
  } catch (e) { el.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; }
}

loadAccounts();
</script>
</body>
</html>`;
