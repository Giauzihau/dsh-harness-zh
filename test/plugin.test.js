import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../lib/index.js'

/** Minimal stand-in for the harness pieces the plugin touches. */
class FakeSystemPrompt {
  constructor() {
    this.calls = 0
    this.sections = []
    this.contexts = []
  }

  section(section) {
    this.sections.push(section)
    return () => {}
  }

  context(context) {
    this.contexts.push(context)
    return () => {}
  }

  refreshContext(assembly) {
    this.calls++
    return {
      ...assembly,
      contexts: assembly.contexts.map((context) => ({ ...context, text: context.english })),
    }
  }
}

class FakeSession {
  constructor() {
    this.events = []
  }

  append(type, data, ...opts) {
    this.events.push({ type, data, opts })
    return { seq: this.events.length, type, data }
  }
}

function makeContext() {
  const systemPrompt = new FakeSystemPrompt()
  // Each context gets its own Session subclass: the plugin patches the
  // prototype, so a shared class would leak patches between tests.
  const Session = class extends FakeSession {}
  const sessions = [new Session(), new Session()]
  const listeners = new Map()
  const ctx = {
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
    get(name) {
      if (name === 'systemPrompt') return systemPrompt
      if (name === 'agents') return { list: () => sessions.map((session) => ({ session })) }
      return undefined
    },
    listeners,
    systemPrompt,
    sessions,
  }
  return ctx
}

function frozenMessage(text, kind = 'runtime-context') {
  const source = kind === undefined ? undefined : Object.freeze({ kind })
  return Object.freeze({
    id: 'm-1',
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    ...(source === undefined ? {} : { source }),
  })
}

test('translates the assembly before the model call', async () => {
  const ctx = makeContext()
  apply(ctx, { verbose: false })

  const [listener] = ctx.listeners.get('system-prompt/assemble')
  const assembly = {
    sections: [{ name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' }],
    contexts: [],
    tools: [],
  }
  const result = await listener(assembly, {}, async () => assembly)
  assert.equal(result.sections[0].text, '你是由 DeepSeek Harness 驱动的 AI 智能体。')
})

test('re-translates refreshContext output, because the loop re-resolves contexts', () => {
  const ctx = makeContext()
  apply(ctx, { verbose: false })

  const refreshed = ctx.systemPrompt.refreshContext({
    sections: [],
    contexts: [
      {
        name: 'working-directory:current',
        english: 'Current working directory: "C:\\\\work".',
      },
    ],
    tools: [],
  })
  assert.equal(refreshed.contexts[0].text, '当前工作目录："C:\\\\work"。')
})

test('translates loop-owned messages on append and never mutates the frozen input', () => {
  const ctx = makeContext()
  apply(ctx, { verbose: false })

  const message = frozenMessage(
    'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: "C:\\\\work".',
  )
  const session = ctx.sessions[0]
  session.append('user/message', message, { surfaceOp: 'append' })

  const [event] = session.events
  assert.notEqual(event.data, message, 'a translated copy is appended, the frozen input is untouched')
  assert.equal(event.data.id, 'm-1', 'message identity is preserved for surface bookkeeping')
  assert.equal(event.data.source.kind, 'runtime-context')
  assert.equal(
    event.data.content[0].text,
    '当前运行时上下文。本快照会取代更早的运行时上下文快照。\n\n当前工作目录："C:\\\\work"。',
  )
  assert.ok(message.content[0].text.startsWith('Current runtime context'), 'input message stays frozen and English')
  assert.deepEqual(event.opts, [{ surfaceOp: 'append' }])
})

test('translates the skill catalog reminder', () => {
  const ctx = makeContext()
  apply(ctx, { verbose: false })

  const message = frozenMessage(
    '<system-reminder>\nA skill is a reusable set of task-specific instructions. The following skills are available in this session:\n\n<available_skills>\n- `demo`: Demo skill.\n</available_skills>\n</system-reminder>',
    'skill-catalog',
  )
  ctx.sessions[0].append('user/message', message)
  const text = ctx.sessions[0].events[0].data.content[0].text
  assert.ok(text.startsWith('<system-reminder>\n技能是一组可复用的'))
  assert.ok(text.includes('- `demo`: Demo skill.'), 'foreign skill descriptions are left alone')
})

test('leaves human prose untouched', () => {
  const ctx = makeContext()
  apply(ctx, { verbose: false })

  const message = frozenMessage('你好，请把这份报告翻译成英文。', undefined)
  ctx.sessions[0].append('user/message', message)
  assert.equal(ctx.sessions[0].events[0].data, message, 'unchanged messages are appended as-is')
})

test('translates harness policy notices by their source kind', () => {
  const ctx = makeContext()
  apply(ctx, { verbose: false })

  const approval = frozenMessage('The approval policy changed from "ask" to "never" (changed by the user).', 'user-approval')
  const directory = frozenMessage('The working directory changed from "C:\\\\a" to "C:\\\\b".', 'working-directory')
  ctx.sessions[0].append('user/message', approval)
  ctx.sessions[0].append('user/message', directory)

  const [first, second] = ctx.sessions[0].events.map((event) => event.data.content[0].text)
  assert.equal(first, '审批策略已由 "ask" 变更为 "never"（由用户更改）。')
  assert.equal(second, '工作目录已由 "C:\\\\a" 变更为 "C:\\\\b"。')
})

test('never rewrites a message that a person typed', () => {
  const ctx = makeContext()
  apply(ctx, { verbose: false })

  // A user message carries `source.kind: "user"`; only harness-owned kinds are eligible.
  const message = frozenMessage('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.', 'user')
  ctx.sessions[0].append('user/message', message)
  assert.equal(ctx.sessions[0].events[0].data, message)
})

test('keeps the system message envelope intact', () => {
  const ctx = makeContext()
  apply(ctx, { verbose: false })

  // System prompt text is translated at assembly time, so the guard leaves it
  // alone here; the envelope must survive either way.
  const message = frozenMessage('You are an AI agent powered by DeepSeek Harness.', 'system-prompt')
  ctx.sessions[0].append('system/message', { turn: 1, step: 1, message })
  const event = ctx.sessions[0].events[0]
  assert.equal(event.data.turn, 1)
  assert.equal(event.data.step, 1)
  assert.equal(event.data.message, message)
})

test('patching twice does not double-wrap the same prototype', () => {
  const ctx = makeContext()
  apply(ctx, { verbose: false })
  apply(ctx, { verbose: false })

  const message = frozenMessage('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')
  ctx.sessions[0].append('user/message', message)
  assert.equal(ctx.sessions[0].events.length, 1)
  assert.equal(ctx.sessions[0].events[0].data.content[0].text, '当前运行时上下文。本快照会取代更早的运行时上下文快照。')
})

test('enabled: false leaves everything English', async () => {
  const ctx = makeContext()
  apply(ctx, { enabled: false })

  assert.equal(ctx.listeners.size, 0)
  assert.equal(ctx.systemPrompt.sections.length, 0, 'the thinking instruction is off too')
  assert.equal(ctx.systemPrompt.contexts.length, 0)
  const message = frozenMessage('You are an AI agent powered by DeepSeek Harness.')
  ctx.sessions[0].append('user/message', message)
  assert.equal(ctx.sessions[0].events[0].data, message)
})

test('thinking: "zh" registers both a section and a runtime-context instruction', () => {
  const ctx = makeContext()
  apply(ctx, { thinking: 'zh' })

  assert.equal(ctx.systemPrompt.sections.length, 1)
  const [section] = ctx.systemPrompt.sections
  assert.equal(section.name, 'harness-zh:reasoning-language')
  assert.equal(section.order, 100, 'placed right after the persona prefix')
  assert.equal(section.interpolate, false)
  assert.match(section.text, /简体中文/)
  assert.match(section.text, /thinking/)

  assert.equal(ctx.systemPrompt.contexts.length, 1, 'also repeated in every runtime snapshot')
  const [context] = ctx.systemPrompt.contexts
  assert.equal(context.name, 'harness-zh:reasoning-language')
  assert.equal(context.order, 900, 'rendered at the end of the snapshot')
  assert.equal(context.interpolate, false)
  assert.equal(context.text, section.text, 'both copies say the same thing')
})

test('thinking accepts true, "en" and a custom instruction', () => {
  const zh = makeContext()
  apply(zh, { thinking: true })
  assert.match(zh.systemPrompt.sections[0].text, /简体中文/)
  assert.match(zh.systemPrompt.contexts[0].text, /简体中文/)

  const en = makeContext()
  apply(en, { thinking: 'en' })
  assert.match(en.systemPrompt.sections[0].text, /reasoning/)
  assert.match(en.systemPrompt.sections[0].text, /Simplified Chinese/)

  const custom = makeContext()
  apply(custom, { thinking: '先想清楚再动手。' })
  assert.equal(custom.systemPrompt.sections[0].text, '先想清楚再动手。')
  assert.equal(custom.systemPrompt.contexts[0].text, '先想清楚再动手。')
})

test('thinking: false registers nothing', () => {
  const ctx = makeContext()
  apply(ctx, {})
  assert.equal(ctx.systemPrompt.sections.length, 0)
  assert.equal(ctx.systemPrompt.contexts.length, 0)
})
