# 发布与更新

仓库：<https://github.com/Giauzihau/dsh-harness-zh>　包名：`dsh-harness-zh`（仓库名与包名一致）。
发布方式：**GitHub 直装**，不打 tarball、不需要构建、不需要 registry。

## 这个仓库里有什么

```
package.json        name/version/engines.dsh，以及 dsh.bundle（插件清单）
cordis.patch.yml    bundle 补丁：插入 id 为 harness-zh 的插件行
lib/index.js        插件本体：三段式翻译 + thinking 段落
lib/translate.js    词典读取、查表、schema 遍历
dict/*.json         8 个词典文件（988 条词条 + 11 条模板）
test/               node:test 用例（25 个，不随包发布）
README.md           说明（简体中文）
LICENSE  NOTICE     许可证与来源声明
CHANGELOG.md        版本记录
.github/workflows   推上去即跑的测试（Windows + Ubuntu，Node 20/22/24）
```

`files` 字段已经限定发布内容：`lib`、`dict`、`cordis.patch.yml`、两个 README、
`LICENSE`、`NOTICE`。`test/`、`.github/`、`CHANGELOG.md` 不会随包发布，但留在仓库里。

## 首次发仓库

```powershell
cd dsh-harness-zh
git init -b main
git add .
git commit -m "dsh-harness-zh 0.2.5: 把 DSH 模型侧提示词译为简体中文"
git remote add origin https://github.com/Giauzihau/dsh-harness-zh.git
git push -u origin main
```

推之前先在 GitHub 上建好空仓库 `Giauzihau/dsh-harness-zh`，**不要**勾选自动生成
README / .gitignore / LICENSE，否则第一次 push 会被拒绝（远端有本地没有的提交）。

## 用户怎么装

```powershell
dsh plugin --profile web add github:Giauzihau/dsh-harness-zh
```

pnpm 会把 `github:` 规格解析成仓库的 tarball（按 `files` 打包），装进配置档的
`node_modules`，插件管理器读取 `dsh.bundle.patch` 把 `dsh-harness-zh` 追加到
`dsh.profile.bundles`，重启 Harness 后生效。

锁定版本：

```powershell
dsh plugin --profile web add github:Giauzihau/dsh-harness-zh#v0.2.6
```

### 直装路径实测（在本机 DSH 0.2.1-rc.5 上验证过）

用上游 `github:zjl1989-li/dsh-harness-zh-cn` 做了一次真实安装，确认了三件事：

1. `github:` 规格确实能走通：pnpm 从 GitHub 拉 tarball、按包内 `files` 落盘、
   插件管理器把包名追加进 `dsh.profile.bundles`。上游带 npm 依赖，走了 npm
   registry，耗时 2 分钟；本插件零依赖，只会慢在 GitHub 那一步。
2. 安装后的兼容性闸门按 `engines.dsh` 判定：上游声明
   `@deepseek-ai/dsh-system-prompt: ^0.1.0-rc.6`，当场被拒——
   `installation rejected: Plugin dsh-harness-zh-cn@0.2.0 is incompatible with dsh 0.2.1-rc.5`，
   并自动回滚 `package.json`、`pnpm-lock.yaml` 和 `node_modules`。这正是本插件写
   `engines.dsh: "^0.2.1-rc.5"` 的原因。
3. 只有带 `prepare` 脚本的 git 包才需要 `allowBuilds`：pnpm 会拦住 git 依赖的构建，
   CLI 提示把 pnpm 打印的键加到 `<配置档>\pnpm-workspace.yaml`。本包不含构建脚本，
   所以不需要这一步；若以后引入构建流程，记得同步文档。

网络提示：`HEAD https://github.com/<owner>/<repo>` 可能先两次超时再成功，
首次安装耐心等；GitHub 完全不可达时用 `file:` 安装克隆目录。

## 以后怎么发新版

1. 改 `package.json` 的 `version`（例如 `0.2.6`），在 `CHANGELOG.md` 顶部加一节。
2. 本地先跑 `node --test`（必须全绿）。
3. 提交并打 tag，push：

   ```powershell
   git add -A; git commit -m "0.2.6: ..."; git tag v0.2.6; git push; git push --tags
   ```

4. 在 GitHub 上基于这个 tag 发 Release（正文抄 CHANGELOG 那一段即可）。
5. 已安装的用户执行同一条 `add github:...` 命令即可升级到默认分支；
   要锁 tag 就在命令后加 `#v0.2.6`。

**必须改 version 的原因**：pnpm 会按版本缓存 `file:`/git 依赖，版本号不变时重装可能
拿回旧字节。版本号是唯一的缓存键。

## 兼容性提醒

`engines.dsh` 写的是 `^0.2.1-rc.5`。DSH 的安装闸门
（`dsh-app-boot` 的 `evaluatePluginCompatibility`）只看 `engines.dsh`，
所以 **DSH 一旦升到 0.2.2 或 0.3，本插件会被判定为不兼容并拒绝加载**。
届时的处理顺序：

1. 先确认提示词文本没变，只需把 `engines.dsh` 放宽/改到新版本，发补丁版；
2. 若文本变了，用 `dumpMisses: true` 抓出未命中的新句子，补词典；
3. 临时绕过（不推荐长期用）：`dsh plugin --profile <p> allow-version ...` 把
   该包加入 `compatibility.json` 豁免。

## 可选：再发一份 npm

包本身已经满足 npm 发布条件（无依赖、无构建、`files` 明确）。若以后要发：

```powershell
npm publish --access public
```

发布后 `dsh plugin --profile web add dsh-harness-zh` 也能用；两种渠道可以并存，
互不冲突。发之前先 `npm view dsh-harness-zh version` 确认名字没被别人占用。
