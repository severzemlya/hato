#!/usr/bin/env bun
/**
 * hato hub: session ledger + message routing.
 *
 * - Channels (channel/server.ts) connect and register over WebSocket (/ws)
 * - The CLI and tools talk HTTP:
 *     GET  /api/sessions                         list sessions
 *     POST /api/send      {to, from?, content}   send; to='*' broadcasts to all online
 *     GET  /api/log?session=&limit=              message history
 *     POST /api/rename    {from, to}             rename a session
 *     POST /api/activity  {host, claude_pid, state}  working/idle reports from hooks
 *     GET  /healthz
 * - Ledger and inbox persist in SQLite (~/.local/share/hato/hato.db)
 * - No auth: meant to be reachable only from loopback / inside a Tailnet
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { BROADCAST, DEFAULT_PORT, type ClientMsg, type MessageRow, type ServerMsg, type SessionRow } from '../shared/proto.ts'

const PORT = Number(process.env.HATO_PORT ?? DEFAULT_PORT)
const DATA_DIR = process.env.HATO_DATA_DIR ?? join(homedir(), '.local', 'share', 'hato')
const MSG_TTL_DAYS = Number(process.env.HATO_MSG_TTL_DAYS ?? 7)
const SESSION_TTL_DAYS = Number(process.env.HATO_SESSION_TTL_DAYS ?? 14)
mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(join(DATA_DIR, 'hato.db'))
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    cwd TEXT NOT NULL,
    pid INTEGER NOT NULL,
    claude_pid INTEGER,
    title TEXT,
    status TEXT,
    activity TEXT,
    activity_at TEXT,
    online INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS sessions_name ON sessions(name);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_name TEXT NOT NULL,
    from_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  );
  CREATE INDEX IF NOT EXISTS messages_undelivered ON messages(to_name) WHERE delivered_at IS NULL;
`)
// Migrate older schemas (add columns if missing)
for (const col of ['claude_pid INTEGER', 'activity TEXT', 'activity_at TEXT']) {
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`)
  } catch {
    /* already there */
  }
}

// Nobody is connected right after startup — clear stale online flags from a previous crash
db.exec('UPDATE sessions SET online = 0')

type WsData = { sessionId?: string }
const socketsBySessionId = new Map<string, Bun.ServerWebSocket<WsData>>()

const now = () => new Date().toISOString()
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()

function send(ws: Bun.ServerWebSocket<WsData>, msg: ServerMsg) {
  ws.send(JSON.stringify(msg))
}

// ---------- naming ----------

// Bird name pool (Japanese). When exhausted, -2, -3, … suffixes are added.
const BIRD_NAMES = [
  'suzume', 'tsubame', 'hibari', 'mozu', 'kawasemi', 'fukurou', 'taka', 'washi',
  'tsuru', 'sagi', 'kamome', 'chidori', 'uguisu', 'mejiro', 'hiyodori', 'kiji',
  'yamagara', 'shijuukara', 'enaga', 'kogera', 'misosazai', 'komadori',
  'ruribitaki', 'kawarahiwa', 'ikaru', 'hojiro', 'kakesu', 'onaga', 'sekirei',
  'tobi', 'hayabusa', 'kounotori', 'toki', 'kamo', 'ahiru', 'ousama-penguin',
]

const sanitizeName = (s: string) =>
  s.replace(/[^\p{L}\p{N}_.-]/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48)

function nameTaken(name: string, selfId?: string): boolean {
  const holder = db.query<SessionRow, [string]>('SELECT * FROM sessions WHERE name = ?').get(name)
  return !!holder && holder.id !== selfId
}

function randomFreeName(selfId: string): string {
  const shuffled = [...BIRD_NAMES].sort(() => Math.random() - 0.5)
  for (const cand of shuffled) if (!nameTaken(cand, selfId)) return cand
  for (let n = 2; ; n++) {
    for (const cand of shuffled) if (!nameTaken(`${cand}-${n}`, selfId)) return `${cand}-${n}`
  }
}

/** Assign a unique name (random when nothing is requested) */
function assignName(requested: string | undefined, selfId: string): string {
  if (!requested) return randomFreeName(selfId)
  const base = sanitizeName(requested) || 'session'
  let name = base
  for (let n = 2; ; n++) {
    const holder = db.query<SessionRow, [string]>('SELECT * FROM sessions WHERE name = ?').get(name)
    if (!holder || holder.id === selfId) return name
    if (!holder.online) {
      // An offline session yields its name to the newcomer
      // (queued messages are addressed by name, so the newcomer inherits them)
      db.query('DELETE FROM sessions WHERE id = ?').run(holder.id)
      return name
    }
    name = `${base}-${n}`
  }
}

// ---------- registration & delivery ----------

function register(ws: Bun.ServerWebSocket<WsData>, msg: Extract<ClientMsg, { type: 'register' }>) {
  const name = assignName(msg.name, msg.id)
  const t = now()
  db.query(
    `INSERT INTO sessions (id, name, host, cwd, pid, claude_pid, title, online, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, host = excluded.host, cwd = excluded.cwd,
       pid = excluded.pid, claude_pid = excluded.claude_pid, online = 1, last_seen = excluded.last_seen`,
  ).run(msg.id, name, msg.host, msg.cwd, msg.pid, msg.ppid ?? null, msg.title ?? null, t, t)

  ws.data.sessionId = msg.id
  socketsBySessionId.set(msg.id, ws)
  send(ws, { type: 'registered', id: msg.id, name })
  console.log(`[hato] + ${name} (${msg.host}:${msg.cwd})`)

  // Flush queued messages addressed to this name
  const pending = db
    .query<MessageRow, [string]>(
      'SELECT * FROM messages WHERE to_name = ? AND delivered_at IS NULL ORDER BY id',
    )
    .all(name)
  for (const m of pending) {
    send(ws, { type: 'message', msgId: m.id, from: m.from_name, content: m.content, ts: m.created_at })
  }
}

function sessionOf(ws: Bun.ServerWebSocket<WsData>): SessionRow | null {
  if (!ws.data.sessionId) return null
  return db.query<SessionRow, [string]>('SELECT * FROM sessions WHERE id = ?').get(ws.data.sessionId)
}

function pushTo(session: SessionRow, msgId: number, from: string, content: string): boolean {
  const ws = session.online ? socketsBySessionId.get(session.id) : undefined
  if (!ws) return false
  send(ws, { type: 'message', msgId, from, content, ts: now() })
  return true
}

function saveMessage(toName: string, fromName: string, content: string): number {
  const res = db
    .query('INSERT INTO messages (to_name, from_name, content, created_at) VALUES (?, ?, ?, ?)')
    .run(toName, fromName, content, now())
  return Number(res.lastInsertRowid)
}

/** Direct message: persist, then deliver immediately if the target is online */
function routeMessage(toName: string, fromName: string, content: string): 'delivered' | 'queued' | 'unknown' {
  const target = db.query<SessionRow, [string]>('SELECT * FROM sessions WHERE name = ?').get(toName)
  const msgId = saveMessage(toName, fromName, content)
  if (target && pushTo(target, msgId, fromName, content)) return 'delivered'
  return target ? 'queued' : 'unknown'
}

/** Broadcast: every online session except the sender (no queueing for offline ones) */
function broadcast(fromName: string, content: string): number {
  const online = db.query<SessionRow, []>('SELECT * FROM sessions WHERE online = 1').all()
  let count = 0
  for (const s of online) {
    if (s.name === fromName) continue
    const msgId = saveMessage(s.name, fromName, content)
    if (pushTo(s, msgId, fromName, content)) {
      db.query('UPDATE messages SET delivered_at = ? WHERE id = ?').run(now(), msgId) // count as delivered without waiting for ack, so TTL applies
      count++
    }
  }
  return count
}

// ---------- TTL sweep ----------

function sweep() {
  const delMsg = db
    .query('DELETE FROM messages WHERE created_at < ?')
    .run(daysAgo(MSG_TTL_DAYS))
  const delSess = db
    .query('DELETE FROM sessions WHERE online = 0 AND last_seen < ?')
    .run(daysAgo(SESSION_TTL_DAYS))
  if (delMsg.changes || delSess.changes) {
    console.log(`[hato] sweep: messages -${delMsg.changes}, sessions -${delSess.changes}`)
  }
}
sweep()
setInterval(sweep, 3_600_000)

// ---------- HTTP + WS ----------

const json = (body: unknown, status = 200) => Response.json(body, { status })

async function handleApi(req: Request, url: URL): Promise<Response> {
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    const sessions = db
      .query<SessionRow, []>('SELECT * FROM sessions ORDER BY online DESC, last_seen DESC')
      .all()
    return json({ sessions })
  }

  if (url.pathname === '/api/send' && req.method === 'POST') {
    const body = (await req.json()) as { to?: string; from?: string; content?: string }
    if (!body.to || !body.content) return json({ error: 'to and content are required' }, 400)
    const from = body.from ?? 'cli'
    if (body.to === BROADCAST) {
      return json({ result: 'broadcast', delivered: broadcast(from, body.content) })
    }
    const result = routeMessage(body.to, from, body.content)
    if (result === 'unknown') {
      return json(
        { error: `no session named '${body.to}' (message saved — it will be delivered if a session registers under that name)`, result },
        202,
      )
    }
    return json({ result })
  }

  if (url.pathname === '/api/log' && req.method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 30), 200)
    const session = url.searchParams.get('session')
    const messages = session
      ? db
          .query<MessageRow, [string, string, number]>(
            'SELECT * FROM messages WHERE to_name = ? OR from_name = ? ORDER BY id DESC LIMIT ?',
          )
          .all(session, session, limit)
      : db.query<MessageRow, [number]>('SELECT * FROM messages ORDER BY id DESC LIMIT ?').all(limit)
    return json({ messages: messages.reverse() })
  }

  if (url.pathname === '/api/rename' && req.method === 'POST') {
    const body = (await req.json()) as { from?: string; to?: string }
    if (!body.from || !body.to) return json({ error: 'from and to are required' }, 400)
    const target = db.query<SessionRow, [string]>('SELECT * FROM sessions WHERE name = ?').get(body.from)
    if (!target) return json({ error: `no session named '${body.from}'` }, 404)
    const newName = sanitizeName(body.to)
    if (!newName || newName === BROADCAST) return json({ error: `'${body.to}' is not a valid name` }, 400)
    if (nameTaken(newName, target.id)) return json({ error: `'${newName}' is taken` }, 409)
    db.query('UPDATE sessions SET name = ?, last_seen = ? WHERE id = ?').run(newName, now(), target.id)
    db.query('UPDATE messages SET to_name = ? WHERE to_name = ? AND delivered_at IS NULL').run(newName, body.from)
    const ws = socketsBySessionId.get(target.id)
    if (ws) send(ws, { type: 'registered', id: target.id, name: newName }) // refresh the channel's cached name
    console.log(`[hato] ~ ${body.from} → ${newName}`)
    return json({ result: 'renamed', name: newName })
  }

  if (url.pathname === '/api/activity' && req.method === 'POST') {
    const body = (await req.json()) as { host?: string; claude_pid?: number; state?: string }
    if (!body.host || !body.claude_pid || !['working', 'idle'].includes(body.state ?? '')) {
      return json({ error: 'host, claude_pid and state(working|idle) are required' }, 400)
    }
    const res = db
      .query('UPDATE sessions SET activity = ?, activity_at = ? WHERE host = ? AND claude_pid = ? AND online = 1')
      .run(body.state!, now(), body.host, body.claude_pid)
    return json({ result: 'ok', matched: res.changes })
  }

  return new Response('not found', { status: 404 })
}

const server = Bun.serve<WsData, {}>({
  port: PORT,
  hostname: process.env.HATO_HOST ?? '0.0.0.0',
  fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/ws') {
      return srv.upgrade(req, { data: {} })
        ? undefined
        : new Response('upgrade failed', { status: 400 })
    }
    if (url.pathname === '/healthz') return new Response('ok')
    if (url.pathname.startsWith('/api/')) {
      return handleApi(req, url).catch(err => json({ error: String(err) }, 500))
    }
    return new Response('not found', { status: 404 })
  },
  websocket: {
    message(ws, raw) {
      let msg: ClientMsg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return send(ws, { type: 'error', error: 'invalid json' })
      }
      if (msg.type === 'register') return register(ws, msg)

      const session = sessionOf(ws)
      if (!session) return send(ws, { type: 'error', error: 'register first' })

      if (msg.type === 'status') {
        db.query('UPDATE sessions SET title = COALESCE(?, title), status = COALESCE(?, status), last_seen = ? WHERE id = ?')
          .run(msg.title ?? null, msg.status ?? null, now(), session.id)
      } else if (msg.type === 'ack') {
        db.query('UPDATE messages SET delivered_at = ? WHERE id = ?').run(now(), msg.msgId)
      }
    },
    close(ws) {
      const session = sessionOf(ws)
      if (session) {
        socketsBySessionId.delete(session.id)
        db.query('UPDATE sessions SET online = 0, last_seen = ? WHERE id = ?').run(now(), session.id)
        console.log(`[hato] - ${session.name}`)
      }
    },
  },
})

console.log(`[hato] hub listening on ${server.hostname}:${server.port} (db: ${DATA_DIR}/hato.db)`)
