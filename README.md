# dsh-harness-zh

A DeepSeek Harness (DSH) plugin that translates the **model-visible prompt** into Simplified Chinese. Built for **DSH 0.2.1-rc.5**.

The DSH user interface already ships Chinese (`locale` preference plus per-package `locale/zh.json` dictionaries). What stays English is the text baked into the request: system prompt sections, the runtime context (working directory, sandbox policy, approval policy), every tool description and parameter description, and the Cordis API catalog. This plugin rewrites those strings before a request leaves the harness; the UI language is untouched.

## Install

Install straight from GitHub — no build step, because `lib/` is plain ESM and `dict/` is JSON:

```powershell
dsh plugin --profile web add github:Giauzihau/dsh-harness-zh
```

Use the profile you actually run (`web` for the browser GUI, `desktop` for the Electron app). `dsh` is the CLI that ships with the app; on Windows the full path is `& "E:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"` unless you put it on `PATH`.

Pin a tag or commit for a reproducible install:

```powershell
dsh plugin --profile web add github:Giauzihau/dsh-harness-zh#v0.2.5
```

From a local checkout instead:

```powershell
dsh plugin --profile web add file:E:\path\to\dsh-harness-zh
```

Restart Harness afterwards (reloading the web page is not enough for the host process). The plugin activates through `dsh.profile.bundles`, which the plugin manager updates automatically.

Update or remove it with:

```powershell
dsh plugin --profile web add github:Giauzihau/dsh-harness-zh   # update to the latest default branch
dsh plugin --profile web remove dsh-harness-zh
```

## Configuration

Override the row in your profile's `cordis.patch.yml`:

```yaml
- id: harness-zh
  config:
    sections: true         # system prompt sections
    contexts: true         # runtime context (cwd, sandbox, approval policy)
    tools: true            # tool descriptions
    parameters: true       # parameter descriptions (the bulk of the text)
    messages: true         # runtime-context snapshot header, skill catalog reminder
    thinking: false        # ask the model to reason in Chinese (true / zh / en / custom text)
    extraDictionaries: []  # extra dictionary directories
    dumpMisses: false      # write unmatched source text to ~/.dsh/harness-zh-misses.json
    verbose: false         # print per-assembly hit counts to stderr
```

`enabled: false` disables translation without uninstalling.

### `thinking`: the language of the model's reasoning

What the GUI shows in the "思考" panel is **reasoning tokens the model generates itself**, not a fixed string this plugin can look up — no dictionary can translate arbitrary prose. The only workable lever is to ask for it in the system prompt:

```yaml
- id: harness-zh
  config:
    thinking: zh   # same as true; 'en' asks for English; any other string is injected verbatim
```

When enabled, the plugin registers one prompt section right after the persona prefix and before the tool policy blocks:

> 你的私有推理过程（thinking，即界面上“思考”面板里的内容）请始终使用简体中文。无论用户使用何种语言、无论阅读的材料是什么语言，推理都用简体中文；代码、标识符、路径、命令、配置键、引用原文和错误信息保持原样，不要翻译。最终答复的语言按用户的要求决定。

Three things to know:

- **Off by default**: it constrains behaviour rather than replacing text, and can slightly affect reasoning quality.
- **Not guaranteed**: DeepSeek-family models normally follow the instruction, but some providers do not expose or control their chain of thought.
- It only affects the "Thinking" panel, not the language of the final answer.

## How it works: three stages, because one string is rendered more than once

1. **`system-prompt/assemble` waterfall**: translate `sections`, `contexts`, `tools[].description`, and `description` inside every parameter schema, right before the assembly becomes a request.
2. **`SystemPrompt#refreshContext` (prototype patch)**: immediately before a request, `agent-loop.step()` re-resolves every context from its registered provider, which would put the English text back. The patch lives on the prototype, not the instance: `ctx.get()` hands out a fresh accessor for the same service object on every call.
3. **`Session#append` (prototype patch)**: the runtime-context snapshot and the skill catalog are appended by the loop *after* the assembly was translated, and the request handed to an adapter is deep-frozen by `agent-loop.buildRequest()` (an in-place rewrite throws `Cannot assign to read only property 'text'`). So the translation happens at the session boundary: the frozen message is copied, translated, and the copy is appended with the same `id` and `source`.

The plugin imports Node builtins only (`node:fs`, `node:path`, `node:os`, `node:url`): a profile-scoped install cannot resolve `@deepseek-ai/*` from its own `node_modules`.

## Dictionaries

`dict/` holds 8 files, 988 entries and 11 templates:

| File | Contents |
| --- | --- |
| `core.json` | 18 system prompt sections and contexts |
| `tools.json` | 36 tool descriptions |
| `params.json` | 98 parameter descriptions |
| `templates.json` | 3 templates with `{{policy}}` / `{{workspace}}` / `{{path}}` (dynamic contexts) |
| `cordis-api.json` | Cordis API catalog (813 entries taken from the community dictionary, then checked line by line against 0.2.1-rc.5's `api-catalog.js`; stale entries dropped) |
| `messages.json` | fixed sentences of the runtime-context header and the skill catalog reminder |
| `mcp.json` | MCP resource-server section: heading, `server` argument usage, per-server heading |
| `runtime.json` | the other sandbox policy wordings, the approval-disabled sentence, checkout and Web GUI contexts, approval and working-directory change notices, skill catalog update sentences |

Lookup order: exact match, then whitespace-normalized match, then template match (`{{name}}` captures the variable part). Any entry whose `en` contains a `{{name}}` placeholder is treated as a template automatically (the harness interpolates those before the waterfall reaches us); sections composed from several paragraphs, such as the MCP server list, are matched as a whole first and then paragraph by paragraph. A miss leaves the source text untouched: no guessing, no machine translation, and one string always renders the same way.

At the session layer only messages whose `message.source.kind` is one of the four harness-owned kinds (`runtime-context`, `skill-catalog`, `user-approval`, `working-directory`) are translated; anything a person or the assistant writes is appended untouched.

Coverage against the stock 0.2.1-rc.5 headless assembly: 14/14 sections, 3/3 contexts, 25/25 tools, 69 parameter descriptions, zero misses. The web profile adds 11 tools that are covered too (`present`, `schedule_*`, `ask_user_question`, `list_mcp_*`, ...). Measured paragraph by paragraph against a real Web system prompt, 21 of 22 paragraphs hit; the only miss is the Chinese instruction supplied by the wokey MCP server itself.

Text from third-party plugins (`acp_*`, `hindsight_*`, `mcp_connector_*`, `modlens_*`, ...) is intentionally out of scope: it changes with their releases, so bundling it here would rot. Extend the dictionary yourself via `extraDictionaries`, or run `dumpMisses: true` to enumerate what is missing.

### Adding your own dictionary

Drop `*.json` files into a directory listed in `extraDictionaries`, using the bundled format:

```json
{
  "my-plugin:tool:foo": { "kind": "tool", "en": "Original English text.", "zh": "中文译文" }
}
```

The nested community shape (`{ "<package>": { "<key>": { "en": "...", "zh": "..." } } }`) is accepted as well.

## Compatibility

- `engines.dsh: "^0.2.1-rc.5"`: DSH 0.2.1-rc.5's plugin compatibility gate (`evaluatePluginCompatibility`) honours `engines.dsh` and ignores legacy `@deepseek-ai/dsh-*` peer ranges. The community `dsh-harness-zh-cn` release cannot install for exactly that reason: it declares `@deepseek-ai/dsh-system-prompt: ^0.1.0-rc.6`.
- No `peerDependencies`, no `dependencies`, no `Config` schema (schemastery is not required).
- A translation failure always degrades to the original text (every stage is wrapped in try/catch); it can never fail a turn.

## Known limits

- Per-skill descriptions inside the catalog come from the skill packages and stay English; only the reminder's framing sentences are translated.
- Third-party MCP tool text pasted into a session is not in the dictionary.
- If a future harness changes `refreshContext`, `Session#append` or `system-prompt/assemble`, the plugin silently degrades to assembly-only translation (the UI keeps working); `verbose: true` shows where.

## Development

```powershell
node --test        # 25 tests: dictionary lookup, templates, assembly translation, prototype patches, frozen-message append semantics
```

```
lib/index.js      host plugin: three stages, dictionary loading, diagnostics
lib/translate.js  dictionary reading, lookup, schema walking
dict/*.json       dictionaries
cordis.patch.yml  bundle patch that inserts harness-zh
test/             node:test suites
```

## Acknowledgements

- The English source strings in `dict/*.json` are the model-visible prompt text of DeepSeek Harness 0.2.1-rc.5; the Simplified Chinese translations are original work released under the MIT License.
- `dict/cordis-api.json` derives from [dsh-harness-zh-cn](https://github.com/zjl1989-li/dsh-harness-zh-cn) (MIT, Copyright (c) 2026 dsh-harness-zh contributors): 813 of its 1241 entries were re-verified against the 0.2.1-rc.5 API catalog, kept or corrected, and 428 stale entries were dropped.
- No DSH application source is bundled — the dictionaries contain prompt strings and their translations only. Details in [NOTICE](NOTICE).

## License

MIT — see [LICENSE](LICENSE). Attribution for derived translations is in [NOTICE](NOTICE). Release and update steps are in [PUBLISH.zh.md](PUBLISH.zh.md).
