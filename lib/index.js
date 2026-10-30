/**
 * dsh-harness-zh — host half.
 *
 * DeepSeek Harness composes the model-visible prompt at runtime: system prompt
 * sections, assembly contexts, and one JSON schema per tool. All of that text
 * lives in plugin source as English literals, so a UI locale switch does not
 * reach it. This plugin rewrites those strings from a Chinese dictionary before
 * the model call.
 *
 * Three stages are needed because the harness renders the same text more than
 * once per step:
 *
 * 1. `system-prompt/assemble` (waterfall) — sections, contexts and tool schemas.
 * 2. `SystemPrompt#refreshContext` — `agent-loop.step()` re-resolves every
 *    registered context from its provider right before the request, which would
 *    otherwise restore the English text translated in stage 1.
 * 3. `Session#append` — the runtime-context snapshot and the skill catalog are
 *    appended by the loop after the assembly was translated, and the outgoing
 *    request is deep-frozen, so the messages are translated as they are stored.
 *
 * The plugin is intentionally dependency-free: it imports nothing but Node
 * builtins, because a profile-scoped install cannot rely on the harness's own
 * `@deepseek-ai/*` packages being resolvable from the profile's node_modules.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTranslator, loadDictionaries, translateAssembly } from './translate.js'

export const name = 'harness-zh'
export const inject = ['systemPrompt']

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Prefix of the loop-owned runtime-context snapshot message. */
const RUNTIME_CONTEXT_PREFIX = 'Current runtime context'
/** Prefix of the skill catalog reminder message. */
const REMINDER_PREFIX = '<system-reminder>'

/**
 * `message.source.kind` values that only the harness itself writes. Messages
 * carrying one of these are safe to translate line/paragraph-wise; anything
 * else may be prose a person typed, so it is left alone.
 */
const OWNED_SOURCES = new Set(['runtime-context', 'skill-catalog', 'user-approval', 'working-directory'])

/** Section name of the optional reasoning-language instruction. */
const THINKING_SECTION = 'harness-zh:reasoning-language'
/**
 * Placement of that section: right after the deployment persona prefix (order
 * 0) and well before the tool policy blocks, which is where the harness itself
 * states persona-wide rules.
 */
const THINKING_ORDER = 100

const THINKING_TEXTS = {
  zh: '你的私有推理过程（thinking，即界面上“思考”面板里的内容）请始终使用简体中文。无论用户使用何种语言、无论阅读的材料是什么语言，推理都用简体中文；代码、标识符、路径、命令、配置键、引用原文和错误信息保持原样，不要翻译。最终答复的语言按用户的要求决定。',
  en: 'Write your private reasoning (the thinking shown in the "Thinking" panel) in Simplified Chinese, regardless of the language the user writes in or the language of the material you read. Keep code, identifiers, paths, commands, config keys, quoted source text and error messages exactly as they are; the language of the final answer follows the user\u2019s request.',
}

/**
 * Resolve the `thinking` option into section text.
 * @returns the instruction text, or `undefined` when the option is off.
 */
function resolveThinking(value) {
  if (value === undefined || value === null || value === false) return undefined
  if (value === true) return THINKING_TEXTS.zh
  if (typeof value !== 'string') return undefined
  const key = value.trim().toLowerCase()
  if (key === '' || key === 'off' || key === 'false' || key === 'none') return undefined
  if (key === 'zh' || key === 'cn' || key === 'zh-cn' || key === 'chinese') return THINKING_TEXTS.zh
  if (key === 'en' || key === 'english') return THINKING_TEXTS.en
  return value
}

/**
 * Register the reasoning-language instruction as a system prompt section.
 * Registration is scoped to the plugin's context, so unloading the plugin
 * removes it again.
 */
function installThinkingSection(ctx, text, options) {
  const systemPrompt = ctx.get('systemPrompt')
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    report(options, 'thinking: systemPrompt.section() unavailable, instruction skipped')
    return
  }
  try {
    systemPrompt.section({ name: THINKING_SECTION, order: THINKING_ORDER, text, interpolate: false })
    report(options, 'thinking: reasoning-language section registered')
  } catch (error) {
    // A second registration of the same name throws; keep the first one.
    report(options, `thinking: could not register section: ${describe(error)}`)
  }
}

const DEFAULTS = {
  /** Master switch. */
  enabled: true,
  /** Translate system prompt sections (`##` blocks). */
  sections: true,
  /** Translate assembly contexts (working directory, sandbox/approval policy). */
  contexts: true,
  /** Translate tool descriptions inside the tool schemas. */
  tools: true,
  /** Also translate tool parameter descriptions (the bulk of the text). */
  parameters: true,
  /** Translate the loop-owned runtime-context snapshot and skill reminder. */
  messages: true,
  /**
   * Ask the model to do its private reasoning in a given language. `false` (the
   * default) leaves the model alone; `true`/`'zh'` asks for Simplified Chinese;
   * `'en'` asks for English; any other string is used verbatim as the section.
   */
  thinking: false,
  /** Extra dictionary directories, applied after the bundled ones. */
  extraDictionaries: [],
  /** Write untranslated prompt text to this file (or `true` for the DSH home default). */
  dumpMisses: false,
  /** Print a one-line report per assembly to stderr. */
  verbose: false,
}

function normalizeConfig(config) {
  const input = config && typeof config === 'object' ? config : {}
  const options = { ...DEFAULTS }
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) options[key] = value
  }
  if (!Array.isArray(options.extraDictionaries)) options.extraDictionaries = []
  return options
}

/** Diagnostics go to stderr: the harness has no logger service to depend on. */
function report(options, message) {
  if (!options.verbose) return
  try {
    process.stderr.write(`[harness-zh] ${message}\n`)
  } catch {
    // stderr may be closed under the desktop host; diagnostics are optional.
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function missesPath(options) {
  if (typeof options.dumpMisses === 'string' && options.dumpMisses.trim()) {
    return path.resolve(options.dumpMisses)
  }
  if (options.dumpMisses !== true) return undefined
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'harness-zh-misses.json')
}

/**
 * Translate a block paragraph by paragraph: the runtime context snapshot joins
 * one paragraph per registered context.
 */
function translateParagraphs(text, translate) {
  return text
    .split('\n\n')
    .map((paragraph) => translate(paragraph) ?? paragraph)
    .join('\n\n')
}

/** Translate a block line by line: the skill reminder keeps one fact per line. */
function translateLines(text, translate) {
  return text
    .split('\n')
    .map((line) => translate(line) ?? line)
    .join('\n')
}

/**
 * Translate only text the harness itself composed. User and assistant prose is
 * returned untouched, so a dictionary entry can never rewrite what a person
 * typed.
 */
function translateOwnedText(text, translate, kind) {
  if (typeof text !== 'string' || text.length === 0) return text
  if (kind === 'skill-catalog') return translateLines(text, translate)
  if (kind !== undefined) return translateParagraphs(text, translate)
  if (text.startsWith(RUNTIME_CONTEXT_PREFIX)) return translateParagraphs(text, translate)
  if (text.startsWith(REMINDER_PREFIX)) return translateLines(text, translate)
  return text
}

/**
 * Return a copy of one loop-composed message with its text translated. Messages
 * leave `createUserMessage()` deep-frozen, so the copy is what gets appended.
 */
function translateMessage(message, translate) {
  if (!message || typeof message !== 'object') return message
  const kind = message.source && typeof message.source === 'object' ? message.source.kind : undefined
  if (typeof kind === 'string' && !OWNED_SOURCES.has(kind)) return message
  const content = message.content
  if (typeof content === 'string') {
    const text = translateOwnedText(content, translate, kind)
    return text === content ? message : { ...message, content: text }
  }
  if (!Array.isArray(content)) return message

  let changed = false
  const blocks = content.map((block) => {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return block
    const text = translateOwnedText(block.text, translate, kind)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? { ...message, content: blocks } : message
}

/**
 * Stage 2: keep `refreshContext()` output translated. The method re-resolves
 * every context from its registered provider, so without this patch
 * `agent-loop.step()` would put the English provider text back into the request.
 * Patching the prototype (not an instance) is required: every `ctx.get()` call
 * returns a fresh accessor for the same service object.
 */
function installRefreshContextHook(ctx, translator, translateOptions, options) {
  let service
  try {
    service = ctx.get('systemPrompt')
  } catch {
    return
  }
  const proto = service && Object.getPrototypeOf(service)
  const original = proto && proto.refreshContext
  if (typeof original !== 'function' || original.__harnessZh === true) return

  const wrapped = function refreshContext(assembly, context) {
    const refreshed = original.apply(this, arguments)
    try {
      translateAssembly(refreshed, translator.translate, {
        sections: false,
        contexts: translateOptions.contexts,
        tools: false,
        parameters: false,
      })
    } catch (error) {
      report(options, `refreshContext translation failed: ${describe(error)}`)
    }
    return refreshed
  }
  wrapped.__harnessZh = true
  try {
    proto.refreshContext = wrapped
  } catch (error) {
    report(options, `could not hook refreshContext: ${describe(error)}`)
  }
}

/**
 * Stage 3: translate loop-composed messages at the session boundary.
 *
 * The request handed to an adapter is deep-frozen by
 * `agent-loop.buildRequest()`, so the `llm/stream` waterfall cannot rewrite it.
 * The last writable point is `Session#append()`: the loop appends the
 * runtime-context snapshot and the skill catalog there, and `append()` snapshots
 * its payload to JSON immediately afterwards.
 *
 * Sessions are patched through a live agent (`ctx.agents`), which is why the hook
 * is installed lazily: on the first `system-prompt/assemble` the agent exists, and
 * the session it appends to shares one prototype.
 */
const patchedSessionPrototypes = new WeakSet()

function installSessionAppendHook(ctx, translator, options) {
  let agents
  try {
    agents = ctx.get('agents')
  } catch (error) {
    report(options, `session hook: no agents service (${describe(error)})`)
    return
  }
  if (!agents || typeof agents.list !== 'function') {
    report(options, 'session hook: agents service has no list()')
    return
  }

  let live
  try {
    live = agents.list()
  } catch (error) {
    report(options, `session hook: list() failed (${describe(error)})`)
    return
  }
  if (!Array.isArray(live)) return

  for (const agent of live) {
    const session = agent && agent.session
    if (!session || typeof session !== 'object') continue
    const proto = Object.getPrototypeOf(session)
    if (!proto || patchedSessionPrototypes.has(proto)) continue
    const original = proto.append
    if (typeof original !== 'function') continue

    const wrapped = function append(type, data, ...opts) {
      let payload = data
      try {
        if (type === 'user/message') {
          // The event data of a user message *is* the message.
          payload = translateMessage(data, translator.translate)
        } else if (type === 'system/message' && data && typeof data === 'object' && data.message) {
          const message = translateMessage(data.message, translator.translate)
          if (message !== data.message) payload = { ...data, message }
        }
      } catch (error) {
        report(options, `message translation failed: ${describe(error)}`)
      }
      return original.call(this, type, payload, ...opts)
    }
    try {
      proto.append = wrapped
      patchedSessionPrototypes.add(proto)
      report(options, 'session hook: installed')
    } catch (error) {
      report(options, `could not hook session append: ${describe(error)}`)
    }
  }
}

/**
 * Apply the plugin.
 * @param ctx — the plugin context (`inject` guarantees `systemPrompt` exists).
 * @param config — row config from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const options = normalizeConfig(config)
  if (!options.enabled) return

  const directories = [path.join(PACKAGE_ROOT, 'dict')]
  for (const entry of options.extraDictionaries) {
    try {
      directories.push(path.resolve(entry))
    } catch {
      // Ignore unusable extra paths; the bundled dictionary still applies.
    }
  }

  const entries = []
  const loaded = []
  for (const directory of directories) {
    const dictionaries = loadDictionaries(directory)
    if (dictionaries.entries.length > 0) {
      entries.push(...dictionaries.entries)
      loaded.push(directory)
    }
  }

  const translator = createTranslator(entries)
  report(
    options,
    `loaded ${translator.stats.entries} entries (${translator.stats.templates} templates) from ${loaded.length} director${loaded.length === 1 ? 'y' : 'ies'}`,
  )

  const translateOptions = {
    sections: options.sections !== false,
    contexts: options.contexts !== false,
    tools: options.tools !== false,
    parameters: options.parameters !== false,
    // Our own section is already in the target language; keep it out of the
    // miss report instead of counting it as an untranslated string.
    skipSections: [THINKING_SECTION],
  }
  const dumpPath = missesPath(options)

  const thinkingText = resolveThinking(options.thinking)
  if (thinkingText !== undefined) installThinkingSection(ctx, thinkingText, options)

  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    // Translate the final assembly: later listeners may still add or replace text.
    const result = typeof next === 'function' ? await next() : assembly
    if (!result || typeof result !== 'object') return result

    try {
      const report_ = translateAssembly(result, translator.translate, translateOptions)
      report(
        options,
        `sections ${report_.sections}/${report_.sections + report_.sectionsMiss.length}, contexts ${report_.contexts}/${report_.contexts + report_.contextsMiss.length}, tools ${report_.tools}/${report_.tools + report_.toolsMiss.length}, params ${report_.params}`,
      )
      if (dumpPath) writeMisses(dumpPath, report_, options)
      if (options.messages !== false) installSessionAppendHook(ctx, translator, options)
    } catch (error) {
      // Translation must never break a turn: on any failure the original prompt is used.
      report(options, `translation failed: ${describe(error)}`)
    }
    return result
  })

  if (translateOptions.contexts) installRefreshContextHook(ctx, translator, translateOptions, options)

  if (options.messages !== false) {
    // The live agent only exists once the first step starts, so retry on each
    // assembly; already-patched prototypes are remembered.
    installSessionAppendHook(ctx, translator, options)
  }
}

let dumped = false

function writeMisses(file, report_, options) {
  if (dumped) return
  dumped = true
  const payload = {
    generatedAt: new Date().toISOString(),
    note: 'Untranslated model-visible text observed by dsh-harness-zh. Add entries to dict/*.json and restart.',
    sections: report_.sectionsMiss,
    contexts: report_.contextsMiss,
    tools: report_.toolsMiss,
    parameters: report_.paramsMiss,
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
    report(options, `misses written to ${file}`)
  } catch (error) {
    report(options, `could not write ${file}: ${describe(error)}`)
  }
}
