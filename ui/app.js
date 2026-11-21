'use strict';
// app.js — control panel logic. Talks to the main process only through window.bridge.

const $ = (id) => document.getElementById(id);

let state = null;
let cfg = null;
let tools = [];
let connections = [];
let memories = [];
let activePage = 'home';

// ------------------------------------------------------------- utilities

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s';
    setTimeout(() => el.remove(), 220);
  }, 2400);
}

async function copy(text, label = '已复制') {
  await window.bridge.copy(text);
  toast(label, 'ok');
}

function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  return Math.floor(s / 3600) + ' 小时前';
}

// ------------------------------------------------------------ navigation

document.querySelectorAll('.navitem').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.navitem').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    activePage = btn.dataset.page;
    $('page-' + activePage).classList.remove('hidden');
    if (activePage === 'connections') refreshConnections();
    if (activePage === 'memory') refreshMemories();
  });
});

function goPage(name) {
  const btn = document.querySelector('.navitem[data-page="' + name + '"]');
  if (btn) btn.click();
}

// --------------------------------------------------------------- render

function baseFromMcpUrl(url) {
  return String(url || '').replace(/\/mcp\/?$/, '');
}

function renderAddressSelect(s) {
  const sel = $('publicUrlSelect');
  const activeBase = baseFromMcpUrl(s.publicUrl);
  const rows = Array.isArray(s.addressHistory) ? s.addressHistory.slice() : [];
  if (activeBase && !rows.some((x) => x.url === activeBase)) {
    rows.unshift({ url: activeBase, mode: s.tunnelMode || 'stable', label: '当前地址' });
  }
  sel.innerHTML = '';
  if (!rows.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '尚无地址（正在生成…）';
    sel.appendChild(opt);
    return;
  }
  rows.forEach((r) => {
    const opt = document.createElement('option');
    opt.value = r.url;
    opt.textContent = (r.url === activeBase ? '当前 · ' : '') + r.url + (r.mode === 'quick' ? '（临时）' : '');
    sel.appendChild(opt);
  });
  sel.value = activeBase || rows[0].url;
}

function renderStatus(s) {
  state = s;

  const mode = s.tunnelMode || 'stable';
  const modeText = mode === 'stable' ? '固定地址' : (mode === 'named' ? '自有域名' : '临时地址');
  const badge = $('tunnelModeBadge');
  badge.textContent = modeText;
  badge.className = 'tag' + (mode === 'quick' ? ' warn' : '');

  $('connBadge').textContent = String(s.pendingConnections || 0);
  $('connBadge').className = 'navBadge' + ((s.pendingConnections || 0) ? '' : ' zero');
  $('memoryBadge').textContent = String(s.memoryCount || 0);
  $('memoryBadge').className = 'navBadge' + ((s.memoryCount || 0) ? '' : ' zero');

  const pending = s.pendingConnections || 0;
  $('pendingBanner').classList.toggle('hidden', !pending);
  if (pending) $('pendingBannerText').textContent = pending + ' 个设备正在等待你批准，3 分钟内有效。';

  // sidebar pill
  const pill = $('sideState');
  if (!s.running) {
    pill.textContent = '服务已停止';
    pill.className = 'pill off';
  } else if (s.tunnel.state === 'ready') {
    pill.textContent = '运行中 · 公网可达';
    pill.className = 'pill on';
  } else if (s.fallbackState === 'ready') {
    pill.textContent = '运行中 · 临时地址可达';
    pill.className = 'pill on';
  } else if (s.tunnel.state === 'starting') {
    pill.textContent = '运行中 · 隧道连接中';
    pill.className = 'pill';
  } else if (s.tunnel.state === 'error') {
    pill.textContent = '运行中 · 隧道异常';
    pill.className = 'pill bad';
  } else {
    pill.textContent = '运行中 · 仅本机';
    pill.className = 'pill on';
  }

  // hero
  const orb = $('heroOrb');
  const title = $('heroTitle');
  const sub = $('heroSub');
  const btn = $('btnService');

  if (!s.running) {
    orb.className = 'orb';
    title.textContent = '服务未启动';
    sub.textContent = '点击右侧按钮启动 MCP 服务';
    btn.textContent = '启动服务';
    btn.className = 'btn primary';
    btn.disabled = false;
  } else {
    btn.textContent = '停止服务';
    btn.className = 'btn';
    btn.disabled = false;

    if (s.tunnel.state === 'ready') {
      orb.className = 'orb on';
      title.textContent = '服务运行中，公网可达';
      sub.textContent = mode === 'quick' ? 'AI 现在可以连接了（临时地址）' : 'AI 现在可以连接了，地址会一直保留';
    } else if (s.fallbackState === 'ready') {
      orb.className = 'orb warn';
      title.textContent = '固定地址连接中，临时地址已可用';
      sub.textContent = '可以先用临时加速地址连接；固定地址恢复后会自动切换。';
    } else if (s.tunnel.state === 'starting') {
      orb.className = 'orb warn';
      title.textContent = s.publicUrl ? '正在连接固定地址…' : '服务运行中，正在建立隧道…';
      sub.textContent = s.tunnel.error || '通常需要 5 到 15 秒';
    } else if (s.tunnel.state === 'error') {
      orb.className = 'orb bad';
      title.textContent = '隧道启动失败';
      sub.textContent = s.tunnel.error || '';
    } else {
      orb.className = 'orb on';
      title.textContent = '服务运行中，仅本机可访问';
      sub.textContent = '需要公网访问请开启隧道';
    }
  }

  // urls
  renderAddressSelect(s);
  const pu = $('publicUrl');
  if (s.publicUrl) {
    pu.textContent = s.publicUrl;
    pu.className = '';
  } else if (s.tunnel.state === 'starting') {
    pu.textContent = '正在获取地址…';
    pu.className = 'empty';
  } else {
    pu.textContent = '隧道未开启';
    pu.className = 'empty';
  }

  const lu = $('localUrl');
  if (s.localUrl) {
    lu.textContent = s.localUrl;
    lu.className = '';
  } else {
    lu.textContent = '—';
    lu.className = 'empty';
  }

  // tunnel button
  const tb = $('btnTunnel');
  if (!s.running) {
    tb.textContent = '开启隧道';
    tb.disabled = true;
  } else if (s.tunnel.state === 'ready' || s.tunnel.state === 'starting') {
    tb.textContent = '关闭隧道';
    tb.disabled = false;
  } else {
    tb.textContent = '开启隧道';
    tb.disabled = false;
  }

  $('btnRotate').classList.toggle('hidden', mode !== 'stable');
  $('btnClaim').classList.toggle('hidden', mode !== 'stable');

  $('fallbackRow').classList.toggle('hidden', !s.fallbackUrl && s.fallbackState !== 'starting');
  $('fallbackUrl').textContent = s.fallbackUrl || (s.fallbackState === 'starting' ? '正在建立临时加速地址…' : '');

  const hint = $('tunnelHint');
  if (mode === 'stable') {
    hint.textContent = '固定地址会一直保留：重启电脑或程序都不会变，只有点「更换地址」才会换。';
  } else if (mode === 'named') {
    hint.textContent = '使用你在 Cloudflare 配置的固定域名，重启电脑或程序都不会变。';
  } else {
    hint.textContent = '临时地址每次启动都会变。建议到「权限范围」里切换成固定地址。';
  }
  if (s.tunnel.connectMs) {
    hint.textContent += ' 本次连接耗时 ' + (s.tunnel.connectMs / 1000).toFixed(1) + ' 秒。';
  }

  // stats
  $('statRequests').textContent = s.requests ?? 0;
  $('statCalls').textContent = s.toolCalls ?? 0;

  // token + config preview
  if (s.token) {
    $('tokenText').textContent = s.token;
    $('tokenText').className = '';
  }

  const url = s.publicUrl || s.localUrl || '<启动后生成>';
  const preview = {
    mcpServers: {
      'my-computer': {
        type: 'http',
        url: url,
        headers: { Authorization: `Bearer ${s.token || '<token>'}` }
      }
    }
  };
  $('configPreview').textContent = JSON.stringify(preview, null, 2);
}

function renderActivity(item) {
  const list = $('activityList');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = 'actItem';
  el.innerHTML = `<b>${item.tool}</b><span>${ago(item.at)}</span>`;
  list.prepend(el);

  while (list.children.length > 12) list.lastChild.remove();
}

// ----------------------------------------------------- connections / memory

const statusLabel = {
  pending: '待批准',
  approved: '已允许',
  blocked: '已断开',
  denied: '已拒绝',
  expired: '已过期'
};

function connectionMeta(rec) {
  const bits = [];
  const ipText = rec.ip === '127.0.0.1' && !rec.local ? '127.0.0.1（隧道入口）' : (rec.ip || '未知');
  bits.push('IP ' + ipText);
  if (rec.lastSeenAt) bits.push('最后活动 ' + ago(rec.lastSeenAt));
  if (rec.requestCount) bits.push('请求 ' + rec.requestCount + ' 次');
  if (rec.lastTool) bits.push('最近工具 ' + rec.lastTool);
  return bits.join(' · ');
}

function makeConnectionRow(rec, pending) {
  const row = document.createElement('div');
  row.className = 'connRow' + (pending ? ' pending' : '');

  const main = document.createElement('div');
  main.className = 'connMain';
  const name = document.createElement('div');
  name.className = 'connName';
  name.textContent = (rec.name || '未知设备') + (rec.local ? '（本机）' : '');
  const meta = document.createElement('div');
  meta.className = 'connMeta';
  meta.textContent = connectionMeta(rec);
  const ua = document.createElement('div');
  ua.className = 'connMeta';
  ua.textContent = (rec.userAgent || '').slice(0, 120);
  main.append(name, meta, ua);

  const status = document.createElement('span');
  status.className = 'connStatus ' + (rec.status || '');
  status.textContent = statusLabel[rec.status] || rec.status;

  const actions = document.createElement('div');
  actions.className = 'connActions';

  if (pending) {
    const allow = document.createElement('button');
    allow.className = 'btn xs primary';
    allow.textContent = '允许';
    allow.addEventListener('click', async () => {
      await window.bridge.approveConnection(rec.id);
      toast('已允许 ' + (rec.name || '设备'), 'ok');
      await refreshConnections();
    });
    const deny = document.createElement('button');
    deny.className = 'btn xs danger';
    deny.textContent = '拒绝';
    deny.addEventListener('click', async () => {
      await window.bridge.denyConnection(rec.id);
      toast('已拒绝 ' + (rec.name || '设备'), 'warn');
      await refreshConnections();
    });
    actions.append(allow, deny);
  } else {
    const select = document.createElement('select');
    const keep = document.createElement('option');
    keep.value = 'keep';
    keep.textContent = rec.status === 'blocked' ? '已断开' : '保持连接';
    const toggle = document.createElement('option');
    toggle.value = rec.status === 'blocked' ? 'allow' : 'disconnect';
    toggle.textContent = rec.status === 'blocked' ? '允许连接' : '断开连接';
    select.append(keep, toggle);
    select.addEventListener('change', async () => {
      if (select.value === 'disconnect') {
        await window.bridge.blockConnection(rec.id);
        toast('已断开 ' + (rec.name || '设备'), 'warn');
      } else if (select.value === 'allow') {
        await window.bridge.unblockConnection(rec.id);
        toast('已重新允许 ' + (rec.name || '设备'), 'ok');
      }
      await refreshConnections();
    });
    actions.appendChild(select);
  }

  row.append(main, status, actions);
  return row;
}

function renderConnections(list) {
  connections = Array.isArray(list) ? list : [];
  const pending = connections.filter((r) => r.status === 'pending');
  const rest = connections.filter((r) => r.status !== 'pending');

  $('pendingBox').classList.toggle('hidden', !pending.length);
  $('pendingCountTag').textContent = pending.length + ' 个';
  const pendingList = $('pendingList');
  pendingList.innerHTML = '';
  pending.forEach((rec) => pendingList.appendChild(makeConnectionRow(rec, true)));

  const box = $('connectionList');
  box.innerHTML = '';
  if (!rest.length) {
    box.innerHTML = '<div class="empty">还没有连接记录</div>';
  } else {
    rest.forEach((rec) => box.appendChild(makeConnectionRow(rec, false)));
  }
}

async function refreshConnections() {
  try {
    renderConnections(await window.bridge.listConnections());
  } catch (e) {
    toast('读取连接记录失败: ' + e.message, 'bad');
  }
}

function renderMemories(list) {
  memories = Array.isArray(list) ? list : [];
  const box = $('memoryList');
  box.innerHTML = '';
  if (!memories.length) {
    box.innerHTML = '<div class="empty">还没有保存的记忆</div>';
    return;
  }
  memories.forEach((m) => {
    const item = document.createElement('div');
    item.className = 'memoryItem';
    const head = document.createElement('div');
    head.className = 'memoryHead';
    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'memoryTitle';
    title.textContent = m.title;
    const tags = document.createElement('div');
    tags.className = 'memoryTags';
    tags.textContent = (m.tags || []).join(' · ');
    const summary = document.createElement('div');
    summary.className = 'memorySummary';
    summary.textContent = m.summary || '';
    left.append(title, tags, summary);

    const actions = document.createElement('div');
    actions.className = 'memoryActions';
    const open = document.createElement('button');
    open.className = 'btn xs';
    open.textContent = '查看';
    const del = document.createElement('button');
    del.className = 'btn xs danger';
    del.textContent = '删除';
    const body = document.createElement('pre');
    body.className = 'memoryBody';

    open.addEventListener('click', async () => {
      if (item.classList.contains('open')) {
        item.classList.remove('open');
        open.textContent = '查看';
        return;
      }
      if (!body.textContent) {
        const full = await window.bridge.getMemory(m.id);
        body.textContent = full ? full.content : '(记忆不存在)';
      }
      item.classList.add('open');
      open.textContent = '收起';
    });
    del.addEventListener('click', async () => {
      if (!window.confirm('删除这条记忆？')) return;
      await window.bridge.deleteMemory(m.id);
      await refreshMemories();
      toast('已删除记忆', 'ok');
    });
    actions.append(open, del);
    head.append(left, actions);
    item.append(head, body);
    box.appendChild(item);
  });
}

async function refreshMemories() {
  try {
    renderMemories(await window.bridge.listMemories($('memorySearch').value.trim(), 100));
    const st = await window.bridge.memoryStats();
    $('memoryStats').textContent = '共 ' + st.count + ' 条记忆 · 存储：' + st.file;
  } catch (e) {
    toast('读取记忆失败: ' + e.message, 'bad');
  }
}

function renderConfig(c) {
  cfg = c;

  // roots
  const box = $('rootList');
  box.innerHTML = '';
  (c.allowedRoots || []).forEach((p) => {
    const row = document.createElement('div');
    row.className = 'rootItem';
    const sp = document.createElement('span');
    sp.textContent = p;
    sp.title = p;
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = '移除';
    del.addEventListener('click', async () => {
      const next = await window.bridge.removeRoot(p);
      await refreshConfig();
      toast('已移除', 'ok');
    });
    row.append(sp, del);
    box.appendChild(row);
  });
  if (!box.children.length) {
    box.innerHTML = '<div class="empty">还没有添加文件夹</div>';
  }

  $('allowExec').checked = !!c.allowExec;
  $('allowDesktopTools').checked = !!c.allowDesktopTools;
  $('autoMemory').checked = !!c.autoMemory;
  $('autoTunnel').checked = !!c.autoStartTunnel;
  $('launchAtLogin').checked = !!c.launchAtLogin;
  $('startMin').checked = !!c.startMinimized;

  const mode = c.tunnelMode || 'stable';
  $('tunnelMode').value = mode;
  $('stableModeBox').classList.toggle('hidden', mode !== 'stable');
  $('namedModeBox').classList.toggle('hidden', mode !== 'named');
  $('stableUrlView').textContent = c.stableTunnelUrl || '尚未生成';
  $('namedHostname').value = c.namedTunnelHostname || '';
  $('namedToken').value = c.namedTunnelToken || '';

  $('cfgDir').textContent = c.configDir || '—';
}

function renderTools(list) {
  tools = list;
  const box = $('toolList');
  box.innerHTML = '';
  const groups = new Map();
  list.forEach((t) => {
    const cat = t.category || '基础';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(t);
  });
  groups.forEach((items, cat) => {
    const section = document.createElement('div');
    section.className = 'toolGroup';
    const h = document.createElement('div');
    h.className = 'toolGroupHead';
    h.textContent = cat;
    const grid = document.createElement('div');
    grid.className = 'tools';
    items.forEach((t) => {
      const card = document.createElement('div');
      card.className = 'toolCard';
      const n = document.createElement('div');
      n.className = 'toolName';
      n.textContent = t.name;
      const d = document.createElement('div');
      d.className = 'toolDesc';
      d.textContent = t.description;
      card.append(n, d);
      grid.appendChild(card);
    });
    section.append(h, grid);
    box.appendChild(section);
  });
}

// --------------------------------------------------------------- actions

async function refreshConfig() {
  const c = await window.bridge.getConfig();
  renderConfig(c);
}

$('btnService').addEventListener('click', async () => {
  const btn = $('btnService');
  btn.disabled = true;
  try {
    if (state && state.running) {
      await window.bridge.stopService();
      toast('服务已停止');
    } else {
      await window.bridge.startService();
      toast('服务已启动', 'ok');
    }
  } catch (e) {
    toast('操作失败: ' + e.message, 'bad');
  } finally {
    btn.disabled = false;
  }
});

$('btnTunnel').addEventListener('click', async () => {
  if (!state || !state.running) return;
  if (state.tunnel.state === 'ready' || state.tunnel.state === 'starting') {
    await window.bridge.stopTunnel();
    toast('隧道已关闭');
  } else {
    await window.bridge.startTunnel();
    toast('正在建立隧道…');
  }
});

$('copyUrl').addEventListener('click', () => {
  const base = $('publicUrlSelect').value;
  const url = base ? base.replace(/\/+$/, '') + '/mcp' : state?.publicUrl;
  if (url) copy(url, '公网地址已复制');
  else toast('隧道还没开启', 'warn');
});

$('publicUrlSelect').addEventListener('change', (e) => {
  if (e.target.value) $('publicUrl').textContent = e.target.value.replace(/\/+$/, '') + '/mcp';
});

$('copyFallback').addEventListener('click', () => {
  if (state?.fallbackUrl) copy(state.fallbackUrl, '临时加速地址已复制');
  else toast('临时加速地址还没准备好', 'warn');
});

$('goConnections').addEventListener('click', () => goPage('connections'));
$('refreshConnections').addEventListener('click', () => refreshConnections());
$('clearConnections').addEventListener('click', async () => {
  if (!window.confirm('清空全部连接记录？正在连接或等待批准的设备都会被断开。')) return;
  await window.bridge.clearConnections();
  await refreshConnections();
  toast('连接记录已清空', 'ok');
});

$('refreshMemories').addEventListener('click', () => refreshMemories());
$('btnMemorySearch').addEventListener('click', () => refreshMemories());
$('memorySearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') refreshMemories();
});
$('clearMemories').addEventListener('click', async () => {
  if (!window.confirm('清空全部记忆？此操作不可恢复。')) return;
  await window.bridge.clearMemories();
  await refreshMemories();
  toast('记忆已清空', 'ok');
});

$('copyLocal').addEventListener('click', () => {
  if (state?.localUrl) copy(state.localUrl, '本地地址已复制');
  else toast('服务未启动', 'warn');
});

function copyFullConfig() {
  if (!state?.token) return toast('服务未启动', 'warn');
  const url = state.publicUrl || state.localUrl;
  if (!url) return toast('服务未启动', 'warn');
  const cfgText = JSON.stringify({
    mcpServers: {
      'my-computer': {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${state.token}` }
      }
    }
  }, null, 2);
  copy(cfgText, '完整配置已复制');
}

$('copyConfig').addEventListener('click', copyFullConfig);
$('copyConfig2').addEventListener('click', copyFullConfig);

$('btnRotate').addEventListener('click', async () => {
  if (!state || state.tunnelMode !== 'stable') return;
  const ok = window.confirm(
    '更换后公网地址会变成新的，ChatGPT / Claude 里需要重新填一次。\n\n' +
    '注意：更换地址会生成新的 SSH 密钥，生成后必须立即点击「注册固定地址」，' +
    '把新密钥绑定到 tunnl.gg 免费账号，否则固定地址会一直显示「正在获取地址」。\n\n' +
    '确定继续更换吗？'
  );
  if (!ok) return;
  const btn = $('btnRotate');
  btn.disabled = true;
  try {
    await window.bridge.rotateTunnel();
    toast('新密钥已生成，请立即点击「注册固定地址」完成绑定', 'warn');
  } catch (e) {
    toast('更换失败: ' + e.message, 'bad');
  } finally {
    setTimeout(() => { btn.disabled = false; }, 1500);
  }
});

$('btnClaim').addEventListener('click', async () => {
  if (state?.claimUrl) {
    window.bridge.openUrl(state.claimUrl);
    return;
  }
  toast('正在获取注册链接…', 'warn');
  const url = await window.bridge.getClaimLink();
  if (url) window.bridge.openUrl(url);
  else toast('获取注册链接失败，请稍后重试', 'bad');
});

$('tunnelMode').addEventListener('change', async (e) => {
  const mode = e.target.value;
  const labels = { stable: '固定地址', quick: '临时地址', named: '自有 Cloudflare 域名' };
  await window.bridge.updateConfig({ tunnelMode: mode });
  toast('已切换为' + (labels[mode] || mode) + '，正在重连…', mode === 'quick' ? 'warn' : 'ok');
  const [s, c] = await Promise.all([window.bridge.getStatus(), window.bridge.getConfig()]);
  renderStatus(s);
  renderConfig(c);
});

$('saveNamed').addEventListener('click', async () => {
  const hostname = $('namedHostname').value.trim();
  const token = $('namedToken').value.trim();
  if (!hostname || !token) return toast('请填写固定域名和隧道 Token', 'warn');
  await window.bridge.updateConfig({
    tunnelMode: 'named',
    namedTunnelHostname: hostname,
    namedTunnelToken: token
  });
  await window.bridge.restartTunnel();
  toast('已保存，正在连接固定域名…', 'ok');
  const s = await window.bridge.getStatus();
  renderStatus(s);
});

$('launchAtLogin').addEventListener('change', async (e) => {
  await window.bridge.updateConfig({ launchAtLogin: e.target.checked });
  toast(e.target.checked ? '已开启开机自动启动' : '已关闭开机自动启动', 'ok');
});

$('regenToken').addEventListener('click', async () => {
  const r = await window.bridge.regenerateToken();
  toast('令牌已更新，请重新配置 AI', 'warn');
  const s = await window.bridge.getStatus();
  renderStatus(s);
});

$('addRoot').addEventListener('click', async () => {
  const next = await window.bridge.addRoot();
  if (next) {
    await refreshConfig();
    toast('已添加', 'ok');
  }
});

$('allowExec').addEventListener('change', async (e) => {
  await window.bridge.updateConfig({ allowExec: e.target.checked });
  toast(e.target.checked ? '已允许执行命令' : '已禁止执行命令', e.target.checked ? 'warn' : 'ok');
});

$('allowDesktopTools').addEventListener('change', async (e) => {
  await window.bridge.updateConfig({ allowDesktopTools: e.target.checked });
  toast(e.target.checked ? '已允许桌面工具' : '已禁止桌面工具', e.target.checked ? 'warn' : 'ok');
});

$('autoMemory').addEventListener('change', async (e) => {
  await window.bridge.updateConfig({ autoMemory: e.target.checked });
  toast(e.target.checked ? '已开启自动会话记忆' : '已关闭自动会话记忆', 'ok');
});

$('autoTunnel').addEventListener('change', async (e) => {
  await window.bridge.updateConfig({ autoStartTunnel: e.target.checked });
  toast('已保存', 'ok');
});

$('startMin').addEventListener('change', async (e) => {
  await window.bridge.updateConfig({ startMinimized: e.target.checked });
  toast('已保存', 'ok');
});

$('openCfgDir').addEventListener('click', () => window.bridge.openConfigDir());

// ------------------------------------------------------------------ boot

(async function boot() {
  window.bridge.onStatus(renderStatus);
  window.bridge.onToast((t) => toast(t.text, t.kind));
  window.bridge.onActivity(renderActivity);
  window.bridge.onConnection(async (payload) => {
    if (payload && payload.type === 'request') {
      toast('新设备请求连接：' + ((payload.record && payload.record.name) || '未知设备'), 'warn');
    }
    await refreshConnections();
    const s = await window.bridge.getStatus();
    renderStatus(s);
    if (activePage === 'connections') refreshConnections();
  });
  window.bridge.onMemory((list) => {
    if (activePage === 'memory') renderMemories(list);
  });

  const [s, c, t] = await Promise.all([
    window.bridge.getStatus(),
    window.bridge.getConfig(),
    window.bridge.getTools()
  ]);

  renderStatus(s);
  renderConfig(c);
  renderTools(t);
  await Promise.all([refreshConnections(), refreshMemories()]);
})();
