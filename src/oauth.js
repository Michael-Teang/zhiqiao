'use strict';
// oauth.js — minimal OAuth 2.1 authorization server for MCP clients that require it
// (ChatGPT connectors use the OAuth flow rather than plain bearer headers).
//
// Flow:
//   1. client hits /mcp without a token -> 401 with resource_metadata URL
//   2. client fetches /.well-known/oauth-protected-resource
//   3. client fetches /.well-known/oauth-authorization-server
//   4. client registers via POST /register (dynamic client registration)
//   5. client opens /authorize -> user pastes the access token from the panel
//   6. server redirects back with ?code=...
//   7. client POSTs /token with code + PKCE verifier -> gets access_token
//   8. client calls /mcp with Authorization: Bearer <access_token>
//
// The issued access_token IS the bridge token from config.json, so there is a single
// secret to manage and rotating it invalidates every issued grant.

const crypto = require('node:crypto');
const { getConfig } = require('./config.js');

// authorization codes: code -> { clientId, redirectUri, challenge, method, expiresAt }
const codes = new Map();
// dynamic client registrations: client_id -> { redirectUris, name, createdAt }
const clients = new Map();

const CODE_TTL_MS = 5 * 60 * 1000;

function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return proto + '://' + host;
}

function pruneCodes() {
  const now = Date.now();
  for (const [c, v] of codes) {
    if (now > v.expiresAt) codes.delete(c);
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function verifyPkce(verifier, challenge, method) {
  if (!challenge) return true;
  if (!verifier) return false;
  if ((method || 'S256') === 'plain') return verifier === challenge;
  const digest = crypto.createHash('sha256').update(verifier).digest();
  return b64url(digest) === challenge;
}

// ---------------------------------------------------------------- metadata

function protectedResourceMetadata(req) {
  const base = baseUrl(req);
  return {
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp']
  };
}

function authorizationServerMetadata(req) {
  const base = baseUrl(req);
  return {
    issuer: base,
    authorization_endpoint: base + '/authorize',
    token_endpoint: base + '/token',
    registration_endpoint: base + '/register',
    scopes_supported: ['mcp'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    service_documentation: base + '/'
  };
}

// ------------------------------------------------------- dynamic registration

function registerClient(body) {
  const redirectUris = Array.isArray(body && body.redirect_uris)
    ? body.redirect_uris.filter((u) => typeof u === 'string' && u)
    : [];
  if (!redirectUris.length) return null;

  const clientId = 'dcr_' + crypto.randomBytes(12).toString('base64url');
  clients.set(clientId, {
    redirectUris,
    name: (body && body.client_name) || 'mcp-client',
    createdAt: Date.now()
  });

  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: (body && body.client_name) || 'mcp-client',
    redirect_uris: redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  };
}

function clientAllowedRedirect(clientId, redirectUri) {
  const c = clients.get(clientId);
  if (!c) return false;
  return c.redirectUris.indexOf(redirectUri) >= 0;
}

// ------------------------------------------------------------- authorize page

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function authorizePage(params, error) {
  const hidden = Object.keys(params)
    .map((k) => '<input type="hidden" name="' + escapeHtml(k) + '" value="' + escapeHtml(params[k] || '') + '">')
    .join('\n      ');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>授权智桥-zhiqiao</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:grid;place-items:center;background:#0e0e12;color:#e8e8ee;
       font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:24px}
  .card{width:100%;max-width:420px;background:#16161c;border:1px solid #26262f;
        border-radius:14px;padding:28px}
  h1{font-size:17px;margin-bottom:6px}
  .sub{color:#8a8a99;font-size:12.5px;margin-bottom:20px;line-height:1.7}
  label{display:block;font-size:12px;color:#8a8a99;margin-bottom:7px}
  input[type=text]{width:100%;background:#0a0a0e;border:1px solid #26262f;border-radius:8px;
        padding:11px 13px;color:#e8e8ee;font:12.5px ui-monospace,Consolas,monospace}
  input[type=text]:focus{outline:none;border-color:#7c9cff}
  button{width:100%;margin-top:16px;background:#7c9cff;border:0;border-radius:8px;
        padding:11px;color:#0b0b10;font:inherit;font-weight:600;cursor:pointer}
  button:hover{background:#8fabff}
  .err{background:#2a1c1c;border:1px solid #3a2626;color:#f87171;border-radius:8px;
       padding:10px 13px;font-size:12px;margin-bottom:14px}
  .hint{color:#5c5c6b;font-size:11.5px;margin-top:14px;line-height:1.7}
</style></head><body>
<div class="card">
  <h1>授权智桥-zhiqiao</h1>
  <p class="sub">一个 AI 客户端正在请求访问这台电脑。<br>
     请输入程序面板「连接 AI」页里的访问令牌以确认授权。</p>
  ${error ? '<div class="err">' + escapeHtml(error) + '</div>' : ''}
  <form method="POST" action="/authorize">
      ${hidden}
    <label for="tk">访问令牌</label>
    <input type="text" id="tk" name="token" autocomplete="off" spellcheck="false"
           placeholder="粘贴令牌" autofocus>
    <button type="submit">授权</button>
  </form>
  <p class="hint">令牌在智桥-zhiqiao 窗口的「连接 AI」页面可以复制。
     授权后这个客户端就能读写你允许的文件夹。</p>
</div></body></html>`;
}

// ---------------------------------------------------------------- endpoints

function handleMetadata(req, res, pathname, json) {
  if (pathname === '/.well-known/oauth-protected-resource') {
    return json(res, 200, protectedResourceMetadata(req));
  }
  if (pathname === '/.well-known/oauth-authorization-server') {
    return json(res, 200, authorizationServerMetadata(req));
  }
  if (pathname === '/.well-known/openid-configuration') {
    return json(res, 200, authorizationServerMetadata(req));
  }
  return false;
}

async function handleRegister(req, res, body, json) {
  let parsed = {};
  try { parsed = body ? JSON.parse(body) : {}; } catch (e) { parsed = {}; }
  const out = registerClient(parsed);
  if (!out) {
    return json(res, 400, {
      error: 'invalid_client_metadata',
      error_description: 'redirect_uris is required'
    });
  }
  return json(res, 201, out);
}

function handleAuthorizeGet(req, res, url, html) {
  const p = {};
  for (const k of ['response_type', 'client_id', 'redirect_uri', 'state',
    'code_challenge', 'code_challenge_method', 'scope', 'resource']) {
    const v = url.searchParams.get(k);
    if (v) p[k] = v;
  }

  if (!p.client_id || !p.redirect_uri) {
    return html(res, 400, authorizePage(p, '缺少 client_id 或 redirect_uri'));
  }
  if (!clientAllowedRedirect(p.client_id, p.redirect_uri)) {
    return html(res, 400, authorizePage(p, 'redirect_uri 未在客户端注册中登记'));
  }
  return html(res, 200, authorizePage(p, null));
}

function handleAuthorizePost(req, res, form, html, redirect) {
  const p = {};
  for (const k of ['response_type', 'client_id', 'redirect_uri', 'state',
    'code_challenge', 'code_challenge_method', 'scope', 'resource']) {
    if (form[k]) p[k] = form[k];
  }
  const given = (form.token || '').trim();
  const expected = getConfig().token;

  if (!given || given !== expected) {
    return html(res, 401, authorizePage(p, '令牌不正确，请从程序面板重新复制'));
  }
  if (!clientAllowedRedirect(p.client_id, p.redirect_uri)) {
    return html(res, 400, authorizePage(p, 'redirect_uri 未登记'));
  }

  pruneCodes();
  const code = crypto.randomBytes(24).toString('base64url');
  codes.set(code, {
    clientId: p.client_id,
    redirectUri: p.redirect_uri,
    challenge: p.code_challenge || null,
    method: p.code_challenge_method || 'S256',
    expiresAt: Date.now() + CODE_TTL_MS
  });

  const target = new URL(p.redirect_uri);
  target.searchParams.set('code', code);
  if (p.state) target.searchParams.set('state', p.state);
  return redirect(res, target.toString());
}

function handleToken(req, res, body, json) {
  let p = {};
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.indexOf('application/json') >= 0) {
    try { p = JSON.parse(body || '{}'); } catch (e) { p = {}; }
  } else {
    p = Object.fromEntries(new URLSearchParams(body || ''));
  }

  if (p.grant_type !== 'authorization_code') {
    return json(res, 400, { error: 'unsupported_grant_type' });
  }

  const rec = codes.get(p.code);
  if (!rec) {
    return json(res, 400, { error: 'invalid_grant', error_description: 'code not found or expired' });
  }
  codes.delete(p.code);

  if (Date.now() > rec.expiresAt) {
    return json(res, 400, { error: 'invalid_grant', error_description: 'code expired' });
  }
  if (rec.redirectUri !== p.redirect_uri) {
    return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
  }
  if (!verifyPkce(p.code_verifier, rec.challenge, rec.method)) {
    return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
  }

  const cfg = getConfig();
  return json(res, 200, {
    access_token: cfg.token,
    token_type: 'Bearer',
    expires_in: 315360000,
    scope: 'mcp'
  });
}

module.exports = {
  baseUrl,
  protectedResourceMetadata,
  authorizationServerMetadata,
  registerClient,
  clientAllowedRedirect,
  authorizePage,
  handleMetadata,
  handleRegister,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleToken,
  codes,
  clients
};
