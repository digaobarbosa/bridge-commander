'use strict';

// Conversation identity outlives the worker process and its checkout lease.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SESSION_PROVIDERS, providerInfo } = require('../harness/session-links');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGES = { planning: 'backlog', implementation: 'working', review: 'review', peer: 'peer' };
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);

function validateSession(value) {
  if (!object(value)) return { error: 'session required', code: 400 };
  if (!SESSION_PROVIDERS.includes(value.provider)) return { error: 'session.provider must be ' + SESSION_PROVIDERS.join(' or '), code: 400 };
  if (typeof value.id !== 'string' || !UUID.test(value.id)) return { error: 'session.id must be the exact conversation UUID', code: 400 };
  if (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || value.cwd.includes('\0')) return { error: 'session.cwd must be an absolute directory', code: 400 };
  if (typeof value.host !== 'string' || !value.host.trim() || value.host.length > 255 || /[\s\x00-\x1f]/.test(value.host)) return { error: 'session.host must be a hostname', code: 400 };
  if (value.surface !== undefined && !['app', 'cli'].includes(value.surface)) return { error: 'session.surface must be app or cli', code: 400 };
  const session = { provider: value.provider, id: value.id.toLowerCase(), cwd: value.cwd,
    host: value.host, surface: value.surface || 'cli' };
  session.key = JSON.stringify([session.host, session.provider, session.id]);
  return { session };
}

function remember(card, session, now, origin, makeCurrent = true) {
  if (!Array.isArray(card.sessions)) card.sessions = [];
  const previous = card.sessions.find((s) => s.key === session.key);
  const entry = Object.assign(previous || {}, session, {
    origin: previous && previous.origin === 'managed' ? 'managed' : origin,
    created: previous && previous.created || now, updated: now,
  });
  if (!previous) card.sessions.push(entry);
  if (makeCurrent) card.currentSession = entry.key;
  return entry;
}

function captureManaged(card, worker, { provider, id, host = os.hostname(), now = new Date().toISOString() } = {}) {
  if (!card || !worker || !worker.ref) return null;
  const ref = worker.ref;
  const checked = validateSession({ provider: provider || ref.harness, id: id || ref.resumeId,
    cwd: ref.cwd, host, surface: 'cli' });
  if (checked.error) return null;
  const previous = (card.sessions || []).find((s) => s.key === checked.session.key);
  if (previous) checked.session.surface = previous.surface;
  if (ref.session) checked.session.tmux = { session: ref.session, ...(ref.window ? { window: ref.window } : {}) };
  checked.session.harness = ref.harness;
  const entry = remember(card, checked.session, now, 'managed', !previous || !card.currentSession || card.currentSession === previous.key);
  card.updated = now;
  return entry;
}

function publicSessions(card, host = os.hostname()) {
  return (Array.isArray(card.sessions) ? card.sessions : []).map((s) => {
    const info = providerInfo(s.provider);
    const local = s.host === host;
    let cwdAvailable = false;
    if (local) { try { cwdAvailable = fs.statSync(s.cwd).isDirectory(); } catch {} }
    return Object.assign({}, s, { local, cwdAvailable,
      resumeCli: info && info.cli || '', resumeApp: info && info.app ? { ...info.app } : null });
  });
}

function createSessions(deps) {
  function sync(body) {
    if (!object(body)) return { error: 'JSON object required', code: 400 };
    const checked = validateSession(body.session);
    if (checked.error) return checked;
    if (body.stage !== undefined && !Object.hasOwn(STAGES, body.stage)) return { error: 'stage must be planning, implementation, review or peer', code: 400 };
    for (const field of ['summary', 'nextAction', 'blocker']) {
      if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].length > 4000)) return { error: field + ' must be text up to 4000 characters', code: 400 };
    }
    const session = checked.session;
    const managed = deps.managedCard ? deps.managedCard(session) : null;
    const linked = deps.board().cards.filter((c) => c === managed || (c.sessions || []).some((s) => s.key === session.key));
    if (linked.length > 1 && !body.card) return { error: 'session belongs to several cards; supply card explicitly', code: 409 };
    let card = body.card ? deps.findCard(String(body.card)) : linked[0];
    if (body.card && !card) return { error: 'unknown card: ' + body.card, code: 404 };
    if (managed && card && managed !== card) return { error: 'managed session belongs to card ' + managed.id + '; sync that card to avoid a second client', code: 409 };
    if (!card) {
      const archived = deps.readArchive().find((r) => r.card && (r.card.sessions || []).some((s) => s.key === session.key));
      if (archived) return { error: 'session belongs to archived card ' + archived.card.id + '; restore it or supply an active card explicitly', code: 409 };
      const result = deps.createCard({ title: body.title, owner: body.owner, execution: 'external' });
      if (result.error) return result;
      card = result.card;
    }
    const now = deps.now();
    const oldCheckpoint = card.sessionCheckpoint || {};
    const next = Object.assign({}, oldCheckpoint);
    for (const field of ['summary', 'stage', 'nextAction', 'blocker']) if (body[field] !== undefined) next[field] = body[field];
    const changed = JSON.stringify(next) !== JSON.stringify(oldCheckpoint);
    const entry = remember(card, session, now, card === managed ? 'managed' : 'external');
    if (card === managed && deps.rememberManaged) deps.rememberManaged(card);
    card.updated = now;
    card.sessionCheckpoint = next;
    if (card.execution === 'external' && body.stage !== undefined) {
      card.column = STAGES[body.stage];
      card.pendingOrder = null;
    }
    if (changed) deps.event(card, { text: next.summary || ('session checkpoint: ' + (next.stage || 'updated')), actor: 'bridge-sync', kind: 'session-synced', level: 2 });
    return { card, session: entry };
  }
  return { sync };
}

module.exports = { validateSession, remember, captureManaged, publicSessions, createSessions, STAGES };
