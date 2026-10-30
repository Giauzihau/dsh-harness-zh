# Changelog

## 0.2.5

- `thinking` option: registers a prompt section asking the model to reason in
  Simplified Chinese (the “思考” panel), with `zh` / `en` / custom text.
- `translateAssembly` accepts `skipSections`, so sections the plugin registers
  itself are not reported as dictionary misses.
- Docs: `thinking` section in both READMEs, test counts updated.

## 0.2.4

- Translate harness-owned session messages by `message.source.kind`
  (`runtime-context`, `skill-catalog`, `user-approval`, `working-directory`);
  messages typed by a person are never rewritten.
- `dict/runtime.json`: policy wordings for `read-only` and `danger-full-access`,
  the disabled-approval sentence, checkout/Web-GUI contexts, working-directory
  and approval change notices, skill catalog update sentences.
- `dict/mcp.json` plus paragraph-wise matching for composed sections, so the
  MCP resource-server block is translated only when servers exist.
- Any dictionary entry containing `{{name}}` is now treated as a template
  automatically (the harness interpolates `{{model}}` before the waterfall).
- Tests: 21 → 25.

## 0.2.3

- Translate the runtime-context snapshot at the session boundary
  (`Session#append`) so the English header and skill reminder never reach the
  model; requests are deep-frozen, so this is the only stage that can change
  them.
- `dict/messages.json` for the snapshot header, the cleared notice and the
  reminder framing.

## 0.2.2

- `SystemPrompt#refreshContext` hook: the loop re-renders context text from the
  registered providers, which discarded the assembly translation.

## 0.2.1

- First release for DSH 0.2.1-rc.5: `system-prompt/assemble` waterfall,
  dictionaries for 14 sections / 3 contexts / 25 tools / 69 parameter
  descriptions, 813 re-verified Cordis API entries.
- `engines.dsh: "^0.2.1-rc.5"` — the only compatibility field
  `evaluatePluginCompatibility` honours.
