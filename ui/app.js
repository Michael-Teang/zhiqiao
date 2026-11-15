'use strict';
// app.js — control panel logic. Talks to the main process only through window.bridge.

const $ = (id) => document.getElementById(id);

let state = null;
let cfg = null;
let tools = [];

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
    $('page-' + btn.dataset.page).classList.remove('hidden');
  });
});

// --------------------------------------------------------------- render

function renderStatus(s) {
  state = s;

  // sidebar pill
  const pill = $('sideState');
  if (!s.running) {
    pill.textContent = '服务已停止';
    pill.className = 'pill off';
  } else if (s.tunnel.state === 'ready') {
    pill.textContent = '运行中 · 公网可达';
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
      sub.textContent = 'AI 现在可以连接了';
    } else if (s.tunnel.state === 'starting') {
      orb.className = 'orb warn';
      title.textContent = '服务运行中，正在建立隧道…';
      sub.textContent = '通常需要 5 到 15 秒';
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
  $('autoTunnel').checked = !!c.autoStartTunnel;
  $('startMin').checked = !!c.startMinimized;
  $('cfgDir').textContent = c.configDir || '—';
}

function renderTools(list) {
  tools = list;
  const box = $('toolList');
  box.innerHTML = '';
  list.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'toolCard';
    const n = document.createElement('div');
    n.className = 'toolName';
    n.textContent = t.name;
    const d = document.createElement('div');
    d.className = 'toolDesc';
    d.textContent = t.description;
    card.append(n, d);
    box.appendChild(card);
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
  if (state?.publicUrl) copy(state.publicUrl, '公网地址已复制');
  else toast('隧道还没开启', 'warn');
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

  const [s, c, t] = await Promise.all([
    window.bridge.getStatus(),
    window.bridge.getConfig(),
    window.bridge.getTools()
  ]);

  renderStatus(s);
  renderConfig(c);
  renderTools(t);
})();
