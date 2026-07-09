#!/usr/bin/env bun
/**
 * hato スパイク: 最小の channel MCP サーバ。
 *
 * 検証したいこと:
 *   1. 自作 MCP サーバが experimental capability 'claude/channel' を宣言し、
 *      `claude --channels server:hato-spike` で起動したセッションに対して
 *      notifications/claude/channel を送ると、<channel> タグ付きユーザー入力
 *      としてセッションに注入されるか(アイドル状態でも起きるか)。
 *   2. reply ツールで返信の往復ができるか。
 *
 * 外部からの入力は inbox ファイル(1行=1メッセージ)の追記を監視する。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync, existsSync, writeFileSync, watch, readFileSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INBOX = join(HERE, 'inbox.txt')
const OUTBOX = join(HERE, 'outbox.txt')
const LOG = join(HERE, 'spike.log')

function log(msg: string) {
  appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`)
}

const mcp = new Server(
  { name: 'hato-spike', version: '0.0.1' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions:
      'Messages from hato arrive as <channel source="hato-spike" ...>. Reply with the hato_reply tool.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'hato_reply',
      description: 'Reply to a hato message. Writes to the outbox.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'hato_reply') {
    const text = String((req.params.arguments as { text?: string })?.text ?? '')
    appendFileSync(OUTBOX, `${new Date().toISOString()} ${text}\n`)
    log(`reply: ${text}`)
    return { content: [{ type: 'text', text: 'delivered' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

// inbox 監視: 追記された行を channel 通知として送る
if (!existsSync(INBOX)) writeFileSync(INBOX, '')
let offset = statSync(INBOX).size
let seq = 0

function drainInbox() {
  const size = statSync(INBOX).size
  if (size < offset) offset = 0 // truncate された
  if (size === offset) return
  const chunk = readFileSync(INBOX, 'utf8').slice(offset)
  offset = size
  for (const line of chunk.split('\n')) {
    const content = line.trim()
    if (!content) continue
    seq++
    log(`inbound: ${content}`)
    mcp
      .notification({
        method: 'notifications/claude/channel',
        params: {
          content,
          meta: {
            chat_id: 'spike-chat',
            message_id: String(seq),
            user: 'spike-tester',
            ts: new Date().toISOString(),
          },
        },
      })
      .then(() => log(`notification ${seq} sent ok`))
      .catch(err => log(`notification ${seq} FAILED: ${err}`))
  }
}

watch(HERE, (_event, filename) => {
  if (filename === 'inbox.txt') drainInbox()
})
setInterval(drainInbox, 1000) // watch の取りこぼし保険

await mcp.connect(new StdioServerTransport())
log('spike server connected (stdio)')
