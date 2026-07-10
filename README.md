# Claude Code 汉化工具 (cchans)

对 Claude Code 原生二进制（Bun 编译的 `claude.exe` / `claude`）做**等长原地补丁**的汉化工具。

**零依赖 · 一条命令 · 跟随新版 · 随时还原**

```
npx cchans patch
```

## 为什么造这个轮子

Claude Code 已从 `cli.js` 脚本改为 Bun 编译的原生单文件二进制（~226MB），汉化 = 修改二进制。
现有方案（如 claude-code-zh-cn）采用「解析二进制 → 抽出 JS → 文本替换 → LIEF 重打包」，依赖重、
且靠版本白名单锁死支持范围——CC 一升级就失效，只能等作者更新。

本工具的灵魂是**可持续 + 简单**：

- **等长原地替换**：中文 UTF-8 写入英文串槽位起始，空格填充到原字节长度。文件长度不变、
  不动任何偏移表 → 不需要解析 Bun 结构、不需要重打包、不需要任何第三方依赖。
- **版本无关词典**：词典是「英文串 → 中文串」文本对，对任意包含这些英文串的 claude.exe 都有效。
  CC 升级后老词条大多仍命中，新增词条由 `scan` 报告——**没有版本窗口，永不锁死**。
- **幂等 + 自动跟随**：每次都从纯英文备份出发打补丁。检测到目标是纯英文（刚升级）就自动刷新备份；
  已汉化就用现有备份。升级 CC 后重跑一次 `cchans patch` 即可。

代价是覆盖率：中文比英文长的词条装不下（约 29%，存入 `dict/oversize.json` 备用）。
**约 70% 界面中文 + 永久可用**，胜过 100% 但锁死旧版。

## 使用

```bash
cchans patch [路径]     # 打补丁(自动定位二进制、自动备份、可重复执行)
cchans restore [路径]   # 还原纯英文
cchans status [路径]    # 查看状态(版本/是否已汉化/备份情况)
cchans scan [路径]      # 覆盖扫描 + 词典滞后诊断(--json 完整输出 / --prompt 生成翻译任务提示词)
cchans locate           # 只定位 Claude Code 二进制
```

路径通常可省略（自动从 PATH 和常见安装位置定位），也可用环境变量 `CCHANS_TARGET` 指定。
打补丁前请关闭正在运行的 Claude Code。全量扫描约 1 分钟。

## 平台支持

| 平台 | 支持 | 说明 |
|---|---|---|
| Windows | ✅ | npm 全局 / nvm4w / 原生安装器均可自动定位 |
| macOS | ✅ | 补丁后自动 ad-hoc 重签名（Apple Silicon 必需，`codesign` 系统自带）|
| Linux | ✅ | ELF 无签名校验，直接可用 |

补丁引擎只做字节级搜索替换，不解析 PE/Mach-O/ELF 结构，天然跨格式。
要求 Claude Code 为 **Bun 编译的原生二进制版本**（2.x 起的主流分发形态）；
更早的纯 `cli.js` 脚本版本不在支持范围（那类版本请用文本替换类工具）。
需要 Node.js ≥ 18（仅运行本工具，与 CC 自身的安装方式无关）。

## CC 升级后词典滞后？让 Claude Code 自己补齐

CC 新版会微调文案，导致部分词条不再命中。此时：

```bash
cchans scan --prompt
```

会生成 `cchans-translate-task.md`——一份包含未命中清单、等长约束和完整工作步骤的
**翻译任务提示词**。把它交给 Claude Code（粘贴内容或 `@` 引用文件），CC 会自动：
克隆本仓库 → 在二进制里找到新文案 → 补译词条 → 重建词典 → 重新打补丁并验证。
补完欢迎发 PR 回上游，让所有用户受益。

`cchans patch` 检测到未命中率超过 20% 时也会主动提示这条路径。

## 安全机制

补丁引擎不是盲替换，以下机制均经 226MB 真实二进制字节级断言验证：

1. **长度不变断言**：补丁后长度与源不一致即中止写入，绝不产出损坏文件。
2. **词边界守卫**：像 `Sandbox` 这样的词在压缩代码的标识符里大量出现
   （`SandboxNetworkAccess`），替换会破坏语法。引擎检测命中位置相邻字节，
   在标识符内部的命中一律跳过（实测跳过 400+ 处）。
3. **词典构建过滤**：剔除抽取态占位符（`${...}`）、裸标识符词、会破坏字符串
   字面量语法的译文（引入 en 中没有的引号/反斜杠）。
4. **原子写入**：同目录临时文件 + rename，被占用时给出友好提示而不是半成品。
5. **备份保护**：判定「已汉化」用通用 CJK 检测（兼容其他汉化工具的产物）；
   刷新备份前先字节比对，不同则把旧备份保留为 `.prev` 而非直接覆盖。
6. **语法级验证**：开发期从补丁产物中抽出内嵌 JS（16.5MB），esbuild 完整解析
   通过，与原版一致。

## 词典维护（贡献者）

```bash
node tools/build-dict.cjs   # 从 dict/sources/cli-translations.json 重建等长安全词典
cchans scan                 # 查看当前 CC 版本的命中率与未命中清单
```

上游词典是 `[{en, zh}]` 文本对。CC 新版出现未翻译文案时，把新词条加进
`dict/sources/cli-translations.json` 重跑 build-dict 即可。克隆本仓库的维护者
运行 `scan` 会得到具体的未命中清单提示。

## 致谢

- [claude-code-zh-cn](https://github.com/taekchef/claude-code-zh-cn)（taekchef）——
  上游翻译词典来源，重打包路线的先行者。
- [tweakcc](https://github.com/Piebald-AI/tweakcc)—— Bun 单文件二进制结构的解析参考。

## License

Apache-2.0
