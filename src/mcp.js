'use strict';
// mcp.js — MCP protocol layer: JSON-RPC over streamable HTTP.

const crypto = require('node:crypto');
const { toolCatalog, toolIndex } = require('./tools.js');

const PROTOCOL_DEFAULT = '2024-11-05';
const SERVER_INFO = { name: 'zhiqiao', version: '1.3.0' };

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
          "This bridge lets you read and write files, run shell commands, inspect processes, capture the screen and keep persistent handoff memories on the user's computer. All file paths must stay inside: " + ctx.allowedRoots.join(', ') +
          '. At the start of a task call memory_search to recover context from previous AIs. After every user request, before giving your final answer, call memory_save with a concise handoff record (what the user asked, what you did, key paths/decisions, next steps); do this even for small tasks, keep it 3-8 lines. The bridge also auto-archives tool activity after 60 seconds of inactivity, but that archive does not contain your natural-language answer — your memory_save is the authoritative handoff for the next AI.'
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
        const result = await t.handler(args, ctx);
        if (result && result.__mcpContent && Array.isArray(result.__mcpContent)) {
          return ok(id, { content: result.__mcpContent, isError: false });
        }
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return ok(id, {
          content: [{ type: 'text', text: text }],
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
