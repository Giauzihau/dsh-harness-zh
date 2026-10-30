# dsh-harness-zh

把 **DeepSeek Harness 面向模型的提示词**译成简体中文的 DSH 插件，适配 **DSH 0.2.1-rc.5**。

DSH 的界面本身已经支持中文（`locale` 偏好 + 各插件自带的 `locale/zh.json`）。真正没有中文的是**拼进请求里的英文原文**：系统提示词的各个段落、运行时上下文（工作目录 / 沙箱策略 / 审批策略）、每个工具的描述和参数说明，以及 Cordis API 目录。本插件在请求离开 Harness 之前把这些字符串替换为中文，界面语言不受影响。

## 安装

直接从 GitHub 安装，不需要构建步骤（`lib/` 是纯 ESM，`dict/` 是 JSON）：

```powershell
dsh plugin --profile web add github:Giauzihau/dsh-harness-zh
```

把 `web` 换成你实际在用的配置档（浏览器 GUI 用 `web`，Electron 桌面端用 `desktop`）。`dsh` 是随应用附带的 CLI；在 Windows 上如果没把它加进 `PATH`，完整路径是 `& "E:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"`。

需要可复现的版本时装到指定 tag 或 commit：

```powershell
dsh plugin --profile web add github:Giauzihau/dsh-harness-zh#v0.2.6
```

本地开发也可以直接指向仓库目录：

```powershell
dsh plugin --profile web add file:E:\path\to\dsh-harness-zh
```

两点说明：

- 包里是可直接运行的 JavaScript，没有构建步骤、也没有 `prepare` 脚本，所以 pnpm 不会要求你批准构建（发 TypeScript 源码的插件则需要往 `<配置档>\pnpm-workspace.yaml` 的 `allowBuilds` 里加一条）。
- 首次安装要拉取仓库 tarball，网络慢时可能要一两分钟；如果连不上 GitHub，先 `git clone` 再用 `file:` 安装。

装完重启 Harness（Web GUI 刷新页面不够，宿主进程要重启），插件会随 `dsh.profile.bundles` 自动激活。

更新到默认分支最新版、或卸载：

```powershell
dsh plugin --profile web add github:Giauzihau/dsh-harness-zh
dsh plugin --profile web remove dsh-harness-zh
```

## 配置

配置写在配置档的 `cordis.patch.yml` 里，按插件 id 覆盖：

```yaml
- id: harness-zh
  config:
    sections: true         # 系统提示词段落
    contexts: true         # 运行时上下文（工作目录、沙箱、审批策略）
    tools: true            # 工具描述
    parameters: true       # 工具参数描述（文本量最大的一项）
    messages: true         # 运行时上下文快照头、技能清单提醒
    thinking: false        # 要求模型用中文推理（true / zh / en / 自定义句子），见下文
    extraDictionaries: []  # 额外词典目录，覆盖/补充内置词典
    dumpMisses: false      # 把未命中的原文写到 ~/.dsh/harness-zh-misses.json
    verbose: false         # 在 stderr 打印每次装配的命中统计
```

`enabled: false` 可以整体关闭而不卸载。

### `thinking`：思维链语言

界面上「思考」面板里的内容是**模型自己生成的推理 token**，不是本插件能查表的固定文案——词典再全也翻不了任意自然语言。唯一可行的办法是在系统提示词里要求它：

```yaml
- id: harness-zh
  config:
    thinking: zh   # 等价于 true；'en' 表示要求用英文；其他字符串按原文注入
```

开启后插件会把同一句话**注册两次**：一节系统提示词（紧跟 persona 前缀、在工具策略之前），外加一条运行时上下文（`order: 900`，渲染在每步快照的末尾——模型动手前读到的最后一段文字）：

> 【硬性要求】你的思考过程（thinking／推理／分析，即界面上「思考」面板里显示的全部内容）必须用简体中文写。无论用户使用什么语言、无论正在读的代码或文档是什么语言、无论报错是哪种语言，推理一律用简体中文，不得用英文句子思考。若发现自己已经开始用英文思考，立刻改用简体中文继续。只有代码、标识符、文件路径、命令、配置键、被引用的原文和报错原文保持原样，不翻译。最终答复用哪种语言，按用户的要求决定。

只写在系统提示词里时，部分模型仍会用英文推理（越靠前越容易被忽略）；运行时上下文那份每步都会重新渲染，位置又在末尾，实测更容易生效。

三点须知：

- **默认关闭**，因为这是行为约束而不是文本替换，可能轻微影响推理质量；
- **不保证 100% 生效**：DeepSeek 系模型通常跟随指令语言，但个别 provider 的思维链不受控或不返回明文；
- 它只影响「思考」面板，不改变答复语言——答复语言仍由你（用户）的措辞和模型自身判断决定。

## 工作原理：三步，因为同一段文字会被渲染多次

1. **`system-prompt/assemble`（waterfall）** — 在装配结果交给模型之前翻译 `sections`、`contexts`、`tools[].description` 和参数 schema 里的 `description`。
2. **`SystemPrompt#refreshContext`（原型补丁）** — `agent-loop.step()` 在发请求前会把每个上下文**重新**从注册的 provider 解析一遍，这会把第 1 步翻好的英文还原。补丁在原型上（不是实例上），因为 `ctx.get()` 每次返回同一个服务对象的新访问器。
3. **`Session#append`（原型补丁）** — 运行时上下文快照和技能清单是循环在装配之后自己 `append` 的，而真正发给适配器的请求已被 `agent-loop.buildRequest()` 深冻结（尝试原地改写会抛 `Cannot assign to read only property 'text'`）。因此在**写入会话**这一层翻译：消息对象是冻结的，插件追加一份翻译后的副本，`id` 与 `source` 保持不变。

插件只 import Node 内置模块（`node:fs` / `node:path` / `node:os` / `node:url`），因为配置档的 `node_modules` 里解析不到 `@deepseek-ai/*`。

## 词典

`dict/` 下 8 个文件、988 条词条 + 11 条模板：

| 文件 | 内容 |
| --- | --- |
| `core.json` | 18 条系统提示词段落与上下文 |
| `tools.json` | 36 个工具描述 |
| `params.json` | 98 个参数说明 |
| `templates.json` | 3 条带 `{{policy}}` / `{{workspace}}` / `{{path}}` 的模板（动态上下文） |
| `cordis-api.json` | Cordis API 目录（813 条，取自社区词典并按 0.2.1-rc.5 的 `api-catalog.js` 逐条校对，陈旧条目已剔除） |
| `messages.json` | 运行时上下文快照头、技能清单提醒的固定句式 |
| `mcp.json` | MCP 资源服务器小节：标题、`server` 参数用法、服务器小节标题 |
| `runtime.json` | 另外两种沙箱策略措辞、审批禁用说明、检出目录与 Web GUI 上下文、审批与工作目录变更通知、技能清单更新句式 |

查表顺序：精确匹配 → 空白归一化匹配 → 模板匹配（`{{name}}` 捕获变量）。`en` 里带 `{{name}}` 的词条自动按模板处理（装配前占位符已被替换）；由多段拼成的小节（如 MCP 服务器列表）先整段匹配，再逐段匹配。未命中就保持原样——**绝不猜测、绝不机翻**，同一段文字永远得到同一个译法。

会话层只翻译 `message.source.kind` 属于 harness 自己的四类消息（`runtime-context`、`skill-catalog`、`user-approval`、`working-directory`）；用户或助手写的正文一律原样保留，词典再大也改不到人打的字。

覆盖范围（0.2.1-rc.5 的 headless 装配）：14/14 段落、3/3 上下文、25/25 工具、69 条参数说明，0 未命中。Web 配置档额外带 11 个工具（`present`、`schedule_*`、`ask_user_question`、`list_mcp_*` 等），同样收录；对真实 Web 系统提示词逐段实测为 21/22 命中，唯一未命中的是 wokey MCP 服务器自己提供的中文说明（本来就是中文）。

第三方插件（`acp_*`、`hindsight_*`、`mcp_connector_*`、`modlens_*` 等）的文字**不在范围内**：它们随各自插件版本变化，硬编码进本插件只会随对方升级而腐烂。需要时用 `extraDictionaries` 单独提供，或用 `dumpMisses: true` 把它们找出来。

### 追加自己的词典

`extraDictionaries` 指向的目录里放 `*.json`，格式与内置词典相同：

```json
{
  "my-plugin:tool:foo": { "kind": "tool", "en": "Original English text.", "zh": "中文译文。" }
}
```

嵌套写法（`{ "<包名>": { "<键>": { "en": …, "zh": … } } }`）也能读取，方便直接沿用社区词典。

## 兼容性

- `engines.dsh: "^0.2.1-rc.5"` —— DSH 0.2.1-rc.5 的插件兼容性检查（`evaluatePluginCompatibility`）只认 `engines.dsh`，不认旧的 `@deepseek-ai/dsh-*` peer 版本；社区旧版 `dsh-harness-zh-cn` 之所以装不上，就是它声明了 `@deepseek-ai/dsh-system-prompt: ^0.1.0-rc.6`。
- 插件没有 `peerDependencies`、没有 `dependencies`，也不导出 `Config` schema，因此不需要 schemastery。
- 翻译失败一律降级为原文（每一步都包在 try/catch 里），不会让一轮对话失败。

## 已知边界

- 技能清单里**每个技能自己的描述**来自对应技能包，仍是英文；本插件只翻译那颗提醒的框架句。
- 页面上直接带给模型的第三方 MCP 工具文本不在词典内。
- 若 Harness 后续改了 `refreshContext` / `Session#append` / `system-prompt/assemble` 的形状，插件会静默退化为“只翻译装配阶段”（界面照常可用），`verbose: true` 能看到退化点。

## 开发

```powershell
node --test        # 26 个测试：词典查表、模板、装配翻译、原型补丁、冻结消息的追加语义
```

目录结构：

```
lib/index.js      宿主插件：三次挂载 + 词典加载 + 诊断
lib/translate.js  词典读取、查表、schema 遍历
dict/*.json       词典（8 个文件）
cordis.patch.yml  插入 harness-zh 的 bundle 补丁
test/             node:test 测试（不随包发布）
PUBLISH.zh.md     首次发仓库、发新版、兼容性处理流程
```

## 致谢

- `dict/*.json` 里的英文原文是 DeepSeek Harness 0.2.1-rc.5 面向模型的提示词，中文译文为本项目原创，按 MIT 发布。
- `dict/cordis-api.json` 派生自 [dsh-harness-zh-cn](https://github.com/zjl1989-li/dsh-harness-zh-cn)（MIT，Copyright (c) 2026 dsh-harness-zh contributors）：1241 条中 813 条按 0.2.1-rc.5 的 API 目录重新校对后保留或修正，428 条陈旧条目已删除。
- 仓库不包含 DSH 应用源码，词典里只有提示词原文及其译文。详见 [NOTICE](NOTICE)。

## License

MIT，见 [LICENSE](LICENSE)；派生译文的署名见 [NOTICE](NOTICE)。发布与更新流程见 [PUBLISH.zh.md](PUBLISH.zh.md)。
