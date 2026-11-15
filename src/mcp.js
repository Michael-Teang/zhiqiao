'use strict';
// mcp.js — MCP protocol layer: JSON-RPC over streamable HTTP.

const crypto = require('node:crypto');
const { toolCatalog, toolIndex } = require('./tools.js');

const PROTOCOL_DEFAULT = '2024-11-05';
const SERVER_INFO = { name: 'zhiqiao', version: '1.0.0' };

const sessions = new Map();

function jsonrpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id == null ? null : id, error: { code, message } };
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

async function handleMessage(msg, ctx) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return jsonrpcError(msg && msg.id, -32600, 'invalid request');
  }
  const id = msg.id;
  const method = msg.method;
  const params = msg.params;
  const isNotification = id === undefined || id === null;

  try {
    if (method === 'initialize') {
      const pv = (params && params.protocolVersion) || PROTOCOL_DEFAULT;
      return ok(id, {
        protocolVersion: pv,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'This bridge lets you read and write files and run shell commands on the ' +
          "user's computer. All paths must stay inside: " + ctx.allowedRoots.join(', ')
      });
    }

    if (method === 'notifications/initialized') return null;
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') return ok(id, { tools: toolCatalog() });

    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (!name) return jsonrpcError(id, -32602, 'missing tool name');

      const t = toolIndex().get(name);
      if (!t) return jsonrpcError(id, -32602, 'unknown tool: ' + name);

      try {
        const text = await t.handler(args);
        return ok(id, {
          content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }],
          isError: false
        });
      } catch (e) {
        return ok(id, {
          content: [{ type: 'text', text: 'error: ' + (e && e.message ? e.message : String(e)) }],
          isError: true
        });
      }
    }

    if (isNotification) return null;
    return jsonrpcError(id, -32601, 'method not found: ' + method);
  } catch (e) {
    if (isNotification) return null;
    return jsonrpcError(id, -32603, 'internal error: ' + (e && e.message ? e.message : String(e)));
  }
}

function createSession() {
  const sid = crypto.randomUUID();
  sessions.set(sid, { createdAt: Date.now(), protocolVersion: PROTOCOL_DEFAULT });
  return sid;
}

function hasSession(sid) {
  return sessions.has(sid);
}

function pruneSessions(maxAgeMs) {
  const now = Date.now();
  const cap = maxAgeMs || 24 * 3600 * 1000;
  for (const [sid, s] of sessions) {
    if (now - s.createdAt > cap) sessions.delete(sid);
  }
}

module.exports = { handleMessage, createSession, hasSession, pruneSessions, SERVER_INFO };
