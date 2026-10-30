/**
 * Dictionary loading and prompt translation.
 *
 * The plugin translates the *model-visible* prompt: system prompt sections,
 * assembly contexts, tool descriptions and tool parameter descriptions.
 * Translations are looked up in this order:
 *
 *   1. exact text match
 *   2. whitespace-normalized match (so re-wrapped text still hits)
 *   3. template match, where `{{name}}` placeholders capture the variable part
 *
 * Anything that misses is left untouched, unless the optional LLM fallback is
 * enabled for it.
 */

import fs from 'node:fs'
import path from 'node:path'

const PLACEHOLDER = /\{\{(\w+)\}\}/g

/** Non-global probe: does this string carry a `{{name}}` placeholder? */
const TEMPLATE_HINT = /\{\{\w+\}\}/

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const normalizeWhitespace = (text) => text.replace(/\s+/g, ' ').trim()

/** Flatten one dictionary document into `{ id, kind, en, zh, template }` records. */
function flatten(document, prefix = '') {
  const records = []
  if (!document || typeof document !== 'object') return records
  for (const [key, value] of Object.entries(document)) {
    if (!value || typeof value !== 'object') continue
    if (typeof value.en === 'string' && typeof value.zh === 'string') {
      records.push({
        id: prefix + key,
        kind: typeof value.kind === 'string' ? value.kind : 'text',
        en: value.en,
        zh: value.zh,
        template: value.template === true,
      })
      continue
    }
    records.push(...flatten(value, prefix + key + ':'))
  }
  return records
}

/** Compile a `{{name}}` template into an anchored regular expression plus capture names. */
function compileTemplate(source) {
  let pattern = ''
  const names = []
  let cursor = 0
  for (const match of source.matchAll(PLACEHOLDER)) {
    pattern += escapeRegExp(source.slice(cursor, match.index))
    pattern += '([\\s\\S]*?)'
    names.push(match[1])
    cursor = match.index + match[0].length
  }
  pattern += escapeRegExp(source.slice(cursor))
  return { regex: new RegExp('^' + pattern + '$'), names }
}

/**
 * Read every `*.json` dictionary in `directory`.
 * A missing directory is not fatal: the plugin then simply translates nothing.
 */
export function loadDictionaries(directory) {
  let files = []
  try {
    files = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return { entries: [], files: [] }
  }
  const entries = []
  const used = []
  for (const name of files) {
    try {
      const document = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
      const records = flatten(document)
      if (records.length > 0) {
        entries.push(...records)
        used.push(name)
      }
    } catch {
      // A malformed dictionary must never take the harness down.
    }
  }
  return { entries, files: used }
}

/**
 * Build the lookup tables for a set of dictionary entries.
 * @param entries — flattened records from `loadDictionaries`.
 * @param options.normalizeWhitespaceDefault — also index whitespace-collapsed text.
 */
export function createTranslator(entries, options = {}) {
  const exact = new Map()
  const normalized = new Map()
  const templates = []
  const stats = { entries: entries.length, exact: 0, templates: 0 }

  for (const entry of entries) {
    // `{{name}}` in the English side means the harness interpolates variables
    // before the text reaches us, so such entries can only work as templates.
    if (entry.template || TEMPLATE_HINT.test(entry.en)) {
      const compiled = compileTemplate(entry.en)
      templates.push({ ...compiled, zh: entry.zh, kind: entry.kind, id: entry.id })
      stats.templates++
      continue
    }
    if (!exact.has(entry.en)) exact.set(entry.en, entry.zh)
    const collapsed = normalizeWhitespace(entry.en)
    if (!normalized.has(collapsed)) normalized.set(collapsed, entry.zh)
  }
  // Longest template first: the most specific pattern wins.
  templates.sort((a, b) => b.names.length - a.names.length)

  /**
   * Translate one string.
   * @returns the translation, or `undefined` when nothing matched.
   */
  function translate(text) {
    if (typeof text !== 'string') return undefined
    const trimmed = text.trim()
    if (!trimmed) return undefined

    const direct = exact.get(trimmed)
    if (direct !== undefined) return direct

    const collapsed = normalizeWhitespace(trimmed)
    const loose = normalized.get(collapsed)
    if (loose !== undefined) return loose

    for (const template of templates) {
      const match = template.regex.exec(trimmed)
      if (!match) continue
      const captured = {}
      template.names.forEach((name, index) => {
        captured[name] = match[index + 1]
      })
      return template.zh.replace(PLACEHOLDER, (whole, name) =>
        Object.hasOwn(captured, name) ? captured[name] : whole,
      )
    }
    return undefined
  }

  return { translate, stats, exact, normalized }
}

/**
 * Walk a JSON-Schema-ish value and translate every `description` it carries.
 * Mutates in place: the assembly handed to `system-prompt/assemble` listeners is
 * a fresh object built for this one call.
 */
export function translateSchema(schema, translate, report) {
  if (!schema || typeof schema !== 'object') return
  if (typeof schema.description === 'string') {
    const translated = translate(schema.description)
    if (translated !== undefined) {
      schema.description = translated
      report.hit++
    } else if (schema.description.trim()) {
      report.miss.push(schema.description)
    }
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const value of Object.values(schema.properties)) translateSchema(value, translate, report)
  }
  if (schema.items) translateSchema(schema.items, translate, report)
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    if (Array.isArray(schema[key])) for (const value of schema[key]) translateSchema(value, translate, report)
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    translateSchema(schema.additionalProperties, translate, report)
  }
  if (schema.$defs && typeof schema.$defs === 'object') {
    for (const value of Object.values(schema.$defs)) translateSchema(value, translate, report)
  }
}

/**
 * Translate a block that may hold several paragraphs.
 * Tries the whole text first, then every paragraph on its own — harness sections
 * such as the MCP resource-server list are assembled from parts, so no single
 * dictionary entry can ever cover them.
 */
export function translateBlock(text, translate, options = {}) {
  const whole = translate(text)
  if (whole !== undefined) return whole
  if (options.paragraphs === false) return undefined
  const paragraphs = text.split('\n\n')
  if (paragraphs.length < 2) return undefined
  let changed = false
  const next = paragraphs.map((paragraph) => {
    const translated = translate(paragraph)
    if (translated === undefined) return paragraph
    changed = true
    return translated
  })
  return changed ? next.join('\n\n') : undefined
}

/**
 * Translate a prompt assembly in place.
 * @param assembly — `{ sections, contexts, tools }` from the waterfall.
 * @param options — feature switches (sections / contexts / tools / parameters).
 * @returns a report describing hits and misses.
 */
export function translateAssembly(assembly, translate, options) {
  const report = { sections: 0, sectionsMiss: [], contexts: 0, contextsMiss: [], tools: 0, toolsMiss: [], params: 0, paramsMiss: [] }
  // Sections and contexts this plugin registers itself are already written in
  // the target language; translating them would only report a miss.
  const skip = new Set([
    ...(Array.isArray(options.skipSections) ? options.skipSections : []),
    ...(Array.isArray(options.skipContexts) ? options.skipContexts : []),
  ])

  if (assembly.sections && options.sections) {
    for (const section of assembly.sections) {
      if (!section || typeof section.text !== 'string' || !section.text.trim()) continue
      if (skip.has(section.name)) {
        report.sections++
        continue
      }
      const translated = translateBlock(section.text, translate, options)
      if (translated !== undefined) {
        section.text = translated
        report.sections++
      } else {
        report.sectionsMiss.push({ name: section.name, text: section.text })
      }
    }
  }

  if (assembly.contexts && options.contexts) {
    for (const context of assembly.contexts) {
      if (!context || typeof context.text !== 'string' || !context.text.trim()) continue
      if (skip.has(context.name)) {
        report.contexts++
        continue
      }
      const translated = translateBlock(context.text, translate, options)
      if (translated !== undefined) {
        context.text = translated
        report.contexts++
      } else {
        report.contextsMiss.push({ name: context.name, text: context.text })
      }
    }
  }

  if (assembly.tools && options.tools) {
    for (const tool of assembly.tools) {
      if (!tool) continue
      if (typeof tool.description === 'string' && tool.description.trim()) {
        const translated = translate(tool.description)
        if (translated !== undefined) {
          tool.description = translated
          report.tools++
        } else {
          report.toolsMiss.push({ name: tool.name, text: tool.description })
        }
      }
      if (tool.parameters && options.parameters) {
        const paramReport = { hit: 0, miss: [] }
        translateSchema(tool.parameters, translate, paramReport)
        report.params += paramReport.hit
        if (paramReport.miss.length > 0) report.paramsMiss.push({ name: tool.name, text: paramReport.miss })
      }
    }
  }

  return report
}
