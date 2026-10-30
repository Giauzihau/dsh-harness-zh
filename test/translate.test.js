import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createTranslator,
  loadDictionaries,
  normalizeWhitespace,
  translateAssembly,
  translateSchema,
} from '../lib/translate.js'

const DICT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dict')

function bundledTranslator() {
  const { entries } = loadDictionaries(DICT)
  return createTranslator(entries)
}

test('loads every bundled dictionary file without dropping records', () => {
  const { entries, files } = loadDictionaries(DICT)
  assert.equal(files.length, 8)
  assert.ok(entries.length > 900, `expected the bundled dictionary to be substantial, got ${entries.length}`)
  assert.ok(entries.every((entry) => typeof entry.en === 'string' && typeof entry.zh === 'string'))
})

test('matches an exact string', () => {
  const { translate } = bundledTranslator()
  assert.equal(translate('You are an AI agent powered by DeepSeek Harness.'), '你是由 DeepSeek Harness 驱动的 AI 智能体。')
})

test('matches a whitespace-reflowed string', () => {
  const { translate } = bundledTranslator()
  const reflowed = 'You are an AI agent powered by\n   DeepSeek Harness.'
  assert.equal(translate(reflowed), '你是由 DeepSeek Harness 驱动的 AI 智能体。')
})

test('matches a template and keeps the captured values', () => {
  const { translate } = bundledTranslator()
  const source = 'Current working directory: "C:\\\\work\\\\demo".'
  assert.equal(translate(source), '当前工作目录："C:\\\\work\\\\demo"。')

  const policy =
    'Current DSH file policy: danger-full-access. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: "C:\\\\work\\\\demo". Some platform temporary areas may also be writable.'
  assert.equal(
    translate(policy),
    '当前 DSH 文件策略：danger-full-access。DSH 文件沙箱所约束的操作可以修改会话工作区 "C:\\\\work\\\\demo" 下的文件。部分平台的临时区域也可能可写。',
  )
})

test('treats an entry with placeholders as a template even without the flag', () => {
  const { translate } = bundledTranslator()
  // `deployment:persona-prefix` is stored without `template: true`; the harness
  // interpolates `{{model}}` before the waterfall, so only a template can match.
  assert.equal(
    translate('You are a coding agent powered by the DeepSeek-V4.1-Flash-1017 model.'),
    '你是由 DeepSeek-V4.1-Flash-1017 模型驱动的编码智能体。',
  )
})

test('translates the paragraphs of a composed section', () => {
  const { translate } = bundledTranslator()
  const section = [
    '## MCP resource servers',
    '',
    'Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: ["wokey"].',
    '',
    '### MCP server: wokey',
    '',
    '用 generate_image 调用 Wokey 的 gpt-image-2.5 生成图片。',
  ].join('\n\n')

  const assembly = { sections: [{ name: 'mcp-resource-servers', text: section }], contexts: [], tools: [] }
  const report = translateAssembly(assembly, translate, {
    sections: true,
    contexts: true,
    tools: true,
    parameters: true,
  })

  assert.equal(report.sections, 1)
  assert.match(assembly.sections[0].text, /^## MCP 资源服务器/)
  assert.match(assembly.sections[0].text, /作为 server 参数：\["wokey"\]。/)
  assert.match(assembly.sections[0].text, /### MCP 服务器：wokey/)
  // Server-supplied text is already Chinese and must survive untouched.
  assert.match(assembly.sections[0].text, /用 generate_image 调用 Wokey 的 gpt-image-2\.5 生成图片。/)
})

test('leaves unknown text alone by returning undefined', () => {
  const { translate } = bundledTranslator()
  assert.equal(translate('Some text the dictionary has never seen.'), undefined)
  assert.equal(translate('   '), undefined)
  assert.equal(translate(undefined), undefined)
})

test('normalizes whitespace the same way for lookup and indexing', () => {
  assert.equal(normalizeWhitespace('  a\n\t b  '), 'a b')
})

test('translates an assembly and reports what it could not match', () => {
  const { translate } = bundledTranslator()
  const assembly = {
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'custom', text: 'Untranslated section text.' },
    ],
    contexts: [{ name: 'working-directory:current', text: 'Current working directory: "C:\\\\work".' }],
    tools: [
      {
        name: 'read',
        description:
          'Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files.',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Path to read, resolved by the filesystem backend.',
            },
            limit: { type: 'number', description: 'Unmapped parameter description.' },
          },
        },
      },
    ],
  }

  const report = translateAssembly(assembly, translate, { sections: true, contexts: true, tools: true, parameters: true })

  assert.equal(report.sections, 1)
  assert.equal(report.sectionsMiss.length, 1)
  assert.equal(report.contexts, 1)
  assert.equal(report.tools, 1)
  assert.equal(assembly.contexts[0].text, '当前工作目录："C:\\\\work"。')
  assert.ok(assembly.tools[0].description.startsWith('用 `read` 工具'))
  assert.ok(report.params >= 1)
  assert.equal(report.paramsMiss.length, 1)
})

test('walks nested schema shapes', () => {
  const { translate } = bundledTranslator()
  const report = { hit: 0, miss: [] }
  const schema = {
    type: 'object',
    properties: {
      mode: {
        anyOf: [
          { type: 'string', description: 'Use before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked.' },
        ],
      },
      items: { type: 'array', items: { description: 'Path to read, resolved by the filesystem backend.' } },
    },
  }
  translateSchema(schema, translate, report)
  assert.ok(report.hit >= 1)
})

test('tolerates a malformed dictionary instead of failing', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'harness-zh-'))
  try {
    writeFileSync(path.join(directory, 'broken.json'), '{ not json')
    writeFileSync(path.join(directory, 'good.json'), JSON.stringify({ 'x:y': { kind: 'const', en: 'Hello.', zh: '你好。' } }))
    const { entries, files } = loadDictionaries(directory)
    assert.deepEqual(files, ['good.json'])
    assert.equal(entries.length, 1)
    assert.equal(createTranslator(entries).translate('Hello.'), '你好。')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('skips sections the plugin registered itself', () => {
  const directory = path.resolve('dict')
  const { entries } = loadDictionaries(directory)
  const { translate } = createTranslator(entries)
  const assembly = {
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'harness-zh:reasoning-language', text: '你的私有推理过程请使用简体中文。' },
    ],
    contexts: [],
    tools: [],
    variables: {},
  }
  const report = translateAssembly(assembly, translate, {
    sections: true,
    contexts: true,
    tools: true,
    parameters: true,
    skipSections: ['harness-zh:reasoning-language'],
  })
  assert.equal(report.sections, 2, 'the plugin-owned section counts as translated, not as a miss')
  assert.equal(report.sectionsMiss.length, 0)
  assert.equal(assembly.sections[1].text, '你的私有推理过程请使用简体中文。')
})

test('skips the runtime-context copy of the reasoning instruction too', () => {
  const directory = path.resolve('dict')
  const { entries } = loadDictionaries(directory)
  const { translate } = createTranslator(entries)
  const assembly = {
    sections: [],
    contexts: [
      { name: 'working-directory:current', text: 'Current working directory: "C:\\work".' },
      { name: 'harness-zh:reasoning-language', text: '【硬性要求】你的思考过程必须用简体中文写。' },
    ],
    tools: [],
    variables: {},
  }
  const report = translateAssembly(assembly, translate, {
    sections: true,
    contexts: true,
    tools: true,
    parameters: true,
    skipContexts: ['harness-zh:reasoning-language'],
  })
  assert.equal(report.contexts, 2, 'both contexts count as translated')
  assert.equal(report.contextsMiss.length, 0)
  assert.equal(assembly.contexts[1].text, '【硬性要求】你的思考过程必须用简体中文写。')
})
