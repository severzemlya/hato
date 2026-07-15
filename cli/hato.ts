#!/usr/bin/env bun
/**
 * hato CLI: shared entry point for humans, scripts, and Claude (via Bash).
 *
 *   hato list                     list sessions and posts
 *   hato send <to> <text…>        send a message ('*' broadcasts)
 *   hato broadcast <text…>        broadcast to all online sessions and posts
 *   hato log [name] [-n count]    message history
 *   hato rename <from> <to>       rename a session
 *   hato post new|ls|check|watch|rm   posts: polling mailboxes for agents outside Claude Code
 *   hato statusline               print this session's hato name (for Claude Code statusLine)
 *   hato hub                      run the hub in the foreground (for systemd)
 *
 * The hub address comes from $HATO_HUB (default http://127.0.0.1:8790).
 * From another host: HATO_HUB=http://<hub-host>:8790 hato list
 * If the hub sets HATO_TOKEN, export the same HATO_TOKEN here.
 */

import { hostname } from 'os'
import { BROADCAST, DEFAULT_PORT, type MessageRow, type PostRow, type SessionRow } from '../shared/proto.ts'

const HUB = (process.env.HATO_HUB || `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/$/, '')
const AUTH: Record<string, string> = process.env.HATO_TOKEN
  ? { authorization: `Bearer ${process.env.HATO_TOKEN}` }
  : {}

const USAGE = `usage:
  hato list                     list sessions and posts
  hato send <to> <text…>        send a message ('*' broadcasts)
  hato broadcast <text…>        broadcast to all online sessions and posts
  hato log [name] [-n count]    message history (default 30)
  hato rename <from> <to>       rename a session

  hato post new [name] [-m note]            create a post (random name when omitted)
  hato post ls                              list posts
  hato post check <name> [--peek] [--json]  read waiting messages (and mark them read; --peek keeps them)
  hato post watch <name> [--json]           follow a post — print messages as they arrive (Ctrl-C to stop)
  hato post rm <name>                       remove a post

  hato statusline               print this session's hato name (reads Claude Code statusLine JSON on stdin)
  hato hub                      run the hub (foreground)

env: HATO_HUB=${HUB}`

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${HUB}${path}`, { ...init, headers: { ...AUTH, ...(init?.headers as Record<string, string>) } })
  } catch {
    fail(`cannot reach hub (${HUB}) — start it with 'hato hub' or check HATO_HUB`)
  }
  if (res.status === 401) fail(`hub (${HUB}) rejected the request — export the hub's HATO_TOKEN`)
  return res
}

const post = (path: string, body: unknown) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function doSend(to: string, content: string) {
  const res = await post('/api/send', { to, from: `${process.env.USER ?? 'cli'}@${hostname()}`, content })
  const body = (await res.json()) as { result?: string; delivered?: number; posted?: number; error?: string }
  if (body.error) fail(body.error)
  if (body.result === 'broadcast') {
    console.log(`broadcast sent (delivered to ${body.delivered} sessions${body.posted ? `, ${body.posted} posts` : ''})`)
  } else if (body.result === 'posted') console.log('posted (waiting to be picked up)')
  else console.log(body.result === 'delivered' ? 'delivered' : 'queued (recipient offline)')
}

const fmtPost = (p: PostRow) =>
  `📮 ${p.name.padEnd(16)} ${p.waiting} waiting${p.watching ? ' 👀' : ''}${p.note ? `  [${p.note}]` : ''}`

function printPostMessage(m: MessageRow, asJson: boolean) {
  if (asJson) console.log(JSON.stringify({ id: m.id, from: m.from_name, content: m.content, ts: m.created_at }))
  else console.log(`${m.created_at.slice(5, 16).replace('T', ' ')}  ${m.from_name}: ${m.content}`)
}

const [cmd, ...rest] = process.argv.slice(2)

switch (cmd) {
  case 'list': {
    const [sres, pres] = await Promise.all([api('/api/sessions'), api('/api/posts')])
    const { sessions } = (await sres.json()) as { sessions: SessionRow[] }
    const { posts } = (await pres.json()) as { posts: PostRow[] }
    if (sessions.length === 0 && posts.length === 0) {
      console.log('no sessions registered')
      break
    }
    for (const s of sessions) {
      const mark = s.online ? '●' : '○'
      const act = !s.online ? ' ' : s.activity === 'working' ? '⚡' : s.activity === 'idle' ? '💤' : ' '
      const extra = [s.title, s.status].filter(Boolean).join(' — ')
      console.log(`${mark}${act} ${s.name.padEnd(16)} ${s.host}:${s.cwd}${extra ? `  [${extra}]` : ''}`)
    }
    for (const p of posts) console.log(fmtPost(p))
    break
  }

  case 'send': {
    const [to, ...words] = rest
    if (!to || words.length === 0) fail(USAGE)
    await doSend(to, words.join(' '))
    break
  }

  case 'broadcast': {
    if (rest.length === 0) fail(USAGE)
    await doSend(BROADCAST, rest.join(' '))
    break
  }

  case 'log': {
    const nIdx = rest.indexOf('-n')
    const limit = nIdx >= 0 ? Number(rest[nIdx + 1] ?? 30) : 30
    const args = nIdx >= 0 ? [...rest.slice(0, nIdx), ...rest.slice(nIdx + 2)] : rest
    const session = args[0]
    const qs = new URLSearchParams({ limit: String(limit) })
    if (session) qs.set('session', session)
    const res = await api(`/api/log?${qs}`)
    const { messages } = (await res.json()) as { messages: MessageRow[] }
    if (messages.length === 0) {
      console.log('no messages')
      break
    }
    for (const m of messages) {
      const t = m.created_at.slice(5, 16).replace('T', ' ')
      const state = m.delivered_at ? '' : ' (undelivered)'
      console.log(`${t}  ${m.from_name} → ${m.to_name}${state}: ${m.content}`)
    }
    break
  }

  case 'rename': {
    const [from, to] = rest
    if (!from || !to) fail(USAGE)
    const res = await post('/api/rename', { from, to })
    const body = (await res.json()) as { name?: string; error?: string }
    if (body.error) fail(body.error)
    console.log(`renamed '${from}' → '${body.name}'`)
    break
  }

  // Posts: polling mailboxes for agents that can't receive channel injections
  // (Codex, plain scripts, cron jobs). `watch` long-polls the hub in a loop.
  case 'post': {
    const [sub, ...pargs] = rest
    const flags = pargs.filter(a => a.startsWith('--'))
    const words = pargs.filter(a => !a.startsWith('--'))
    const asJson = flags.includes('--json')

    switch (sub) {
      case 'new': {
        const noteIdx = pargs.indexOf('-m')
        const note = noteIdx >= 0 ? pargs[noteIdx + 1] : undefined
        const name = pargs.filter((_, i) => noteIdx < 0 || (i !== noteIdx && i !== noteIdx + 1))[0]
        const res = await post('/api/post/new', { name, note })
        const body = (await res.json()) as { name?: string; error?: string }
        if (body.error) fail(body.error)
        console.log(`created post '${body.name}' — send with 'hato send ${body.name} …', receive with 'hato post watch ${body.name}'`)
        break
      }

      case 'ls': {
        const res = await api('/api/posts')
        const { posts } = (await res.json()) as { posts: PostRow[] }
        if (posts.length === 0) {
          console.log('no posts')
          break
        }
        for (const p of posts) console.log(fmtPost(p))
        break
      }

      case 'check': {
        const name = words[0]
        if (!name) fail(USAGE)
        const res = await post('/api/post/check', { name, peek: flags.includes('--peek') })
        const body = (await res.json()) as { messages?: MessageRow[]; error?: string }
        if (body.error) fail(body.error)
        if (body.messages!.length === 0 && !asJson) console.log('no new messages')
        for (const m of body.messages!) printPostMessage(m, asJson)
        break
      }

      case 'watch': {
        const name = words[0]
        if (!name) fail(USAGE)
        if (!asJson) console.error(`watching post '${name}' on ${HUB} (Ctrl-C to stop)`)
        while (true) {
          let body: { messages?: MessageRow[]; error?: string }
          try {
            const res = await fetch(`${HUB}/api/post/check`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...AUTH },
              body: JSON.stringify({ name, wait: 60 }),
              signal: AbortSignal.timeout(90_000), // above the hub's wait, below its 150s request timeout
            })
            if (res.status === 401) fail(`hub (${HUB}) rejected the request — export the hub's HATO_TOKEN`)
            body = (await res.json()) as typeof body
          } catch {
            console.error(`hub unreachable (${HUB}) — retrying in 5s`)
            await Bun.sleep(5000)
            continue
          }
          if (body.error) fail(body.error) // post removed, or never existed
          for (const m of body.messages ?? []) printPostMessage(m, asJson)
        }
        break
      }

      case 'rm': {
        const name = words[0]
        if (!name) fail(USAGE)
        const res = await post('/api/post/rm', { name })
        const body = (await res.json()) as { dropped?: number; error?: string }
        if (body.error) fail(body.error)
        console.log(`removed post '${name}'${body.dropped ? ` (dropped ${body.dropped} unread messages)` : ''}`)
        break
      }

      default:
        fail(USAGE)
    }
    break
  }

  // Claude Code statusLine integration: reads the statusLine JSON on stdin and
  // prints this session's hato name (e.g. "🕊 suzume"). Prints nothing and
  // exits 0 when the session is unknown or the hub is unreachable, so it can
  // sit inside any statusline script without breaking it.
  case 'statusline': {
    try {
      const input = JSON.parse(await Bun.stdin.text()) as { session_id?: string }
      if (!input.session_id) process.exit(0)
      const res = await fetch(`${HUB}/api/sessions`, { headers: AUTH, signal: AbortSignal.timeout(1500) })
      const { sessions } = (await res.json()) as { sessions: SessionRow[] }
      const me = sessions.find(s => s.claude_session_id === input.session_id && s.online)
      if (me) console.log(`🕊 ${me.name}`)
    } catch {
      /* hub down or bad input — stay silent */
    }
    process.exit(0)
  }

  // Internal command for the SessionStart hook: bind the Claude Code session id
  // (stdin JSON) to this claude PID so a resumed session gets its old name back.
  // Always exits 0 so a hub outage never breaks the hooks.
  case '_claim': {
    const [flag, pid] = rest
    if (flag !== '--claude-pid' || !pid) process.exit(0)
    try {
      const input = JSON.parse(await Bun.stdin.text()) as { session_id?: string }
      if (!input.session_id) process.exit(0)
      await fetch(`${HUB}/api/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: JSON.stringify({ host: hostname(), claude_pid: Number(pid), session_id: input.session_id }),
        signal: AbortSignal.timeout(2000),
      })
    } catch {
      /* hub down — ignore */
    }
    process.exit(0)
  }

  // Internal command for hooks: report working/idle to the hub.
  // Always exits 0 so a hub outage never breaks the hooks.
  case '_activity': {
    const [state, flag, pid] = rest
    if (!['working', 'idle'].includes(state ?? '') || flag !== '--claude-pid' || !pid) process.exit(0)
    try {
      await fetch(`${HUB}/api/activity`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: JSON.stringify({ host: hostname(), claude_pid: Number(pid), state }),
        signal: AbortSignal.timeout(2000),
      })
    } catch {
      /* hub down — ignore */
    }
    process.exit(0)
  }

  case 'hub':
    await import('../hub/hub.ts')
    break

  default:
    console.log(USAGE)
    process.exit(cmd ? 1 : 0)
}
