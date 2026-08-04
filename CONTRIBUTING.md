# 贡献指南

## 补充/修正词典（最常见的贡献方式）

词典源文件是 [`dict/sources/cli-translations.json`](dict/sources/cli-translations.json)（`[{en, zh}]` 数组）。

1. 跑一遍覆盖扫描，看当前版本还有哪些文案没翻：
   ```bash
   node bin/cchans.js scan
   ```
   如果词典明显滞后于你装的 Claude Code 版本，`scan --prompt` 会直接生成一份可以贴给 Claude Code
   的翻译任务提示词（含硬约束和工作步骤），把输出贴给任意一个 Claude Code 会话就能自动补译：
   ```bash
   node bin/cchans.js scan --prompt > task.md
   ```
2. 手动补充时注意硬约束（违反会被 `tools/build-dict.cjs` 剔除或导致补丁失败）：
   - 译文的 UTF-8 字节数最好 `<=` 英文原文（超长的也可以正常收录，`build-dict` 会自动归入
     `dict/oversize.json`，由 `--full` 引擎负责放入）；
   - 译文不得引入英文原文里没有的 `"` `'` `` ` `` 反斜杠或换行（会破坏 JS 字符串字面量语法）；
   - 不要收录单个通用单词这类"裸短语"（如 `Sandbox`、`Auto-compact`）——它们大概率是别的完整
     英文句子的前缀，翻了会把那句话的开头几个词单独变成中文、句子其余部分留英文，读起来中英
     夹杂。这个坑今天已经踩过好几次，具体案例见 [DEVELOPMENT-NOTES.md](DEVELOPMENT-NOTES.md) §十五/§十六。
3. 改完源词典后必须重新生成构建产物，两者要一起提交：
   ```bash
   node tools/build-dict.cjs
   node test/selftest.js   # 34+ 条断言, 秒级完成
   ```
4. 强烈建议在真实二进制上跑一遍完整验证再提 PR：
   ```bash
   node bin/cchans.js patch --full
   ```
   （会自动备份、打补丁、并实际运行产物验证中文是否正确显示，不会真的损坏你的 `claude.exe`）。

CI（`.github/workflows/test.yml`）会在 PR 里自动跑 `npm test`，并检查 `dict/zh-Hans.json`/
`dict/oversize.json` 是不是从当前的 `dict/sources/cli-translations.json` 正确构建出来的——
忘记跑第 3 步会在这里被拦下。

## 改代码

核心引擎在 `src/patcher.js`（补丁/校验/加锁）、`src/locate.js`（定位二进制）、`src/bunfmt.js`
（Bun 模块表解析）、`src/scan.js`（覆盖扫描）。改动前建议先读一遍 `DEVELOPMENT-NOTES.md`——
里面记录了很多"看起来对但实际会踩坑"的具体教训（字节码 vs 源码、比较谓词守卫、锁的陈旧判定等），
不少弯路已经走过一次，不用再走第二次。

提交前跑：
```bash
node test/selftest.js
```

## 当前只关注 Windows

macOS/Linux 分支代码存在但未经真机验证（见 README 平台支持表），如果你在这两个平台上用过、
遇到问题，欢迎提 issue 或 PR——这部分目前完全靠社区反馈。
