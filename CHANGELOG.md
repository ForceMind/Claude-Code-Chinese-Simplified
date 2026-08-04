# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [SemVer](https://semver.org/)（`0.x` 阶段不承诺稳定公开接口）。
每次改动的完整来龙去脉（踩过的坑、审查记录、实测数据）见 [DEVELOPMENT-NOTES.md](DEVELOPMENT-NOTES.md)，这里只列面向使用者的摘要。

## [0.2.0] - 2026-08-04

### 新增
- 首次发布到 npm：`npx cchans` / `npm install -g cchans` 可直接使用，不再要求 `git clone`。
- Windows NTFS 长路径（>260 字符 `MAX_PATH`）支持：`src/winpath.js` + `src/wfs.js`，覆盖定位、加锁、读写、改名的全部文件操作。
- `.github/workflows/test.yml`：push/PR 到 `main` 时自动跑 `npm test`（windows-latest），并校验词典构建产物没有漂移。
- `package.json` 补上 `"test"` 脚本。

### 修复
- 清理一批"裸短语词条"造成的中英夹杂问题：`Remote Control`、`Auto-compact`、`This session` 及另外 8 条句中截断风险 ≥70% 的词条——逐条用量化占比审计法核实后移除，更具体的复合词条予以保留。
- 补全几处因早期"等长"限制被压缩掉语义的译文（如状态徽标 `auto mode on` → "自动模式已开启"，原来漏译了 "on"）。
- `patchBuffer` 默认路径也按英文字节长度降序处理词条，避免短词条抢先命中长句前缀。
- 撤回一次对锁陈旧判定（`lockIsStale`）的错误修复：曾尝试给"进程存活即不陈旧"加一条无条件的 mtime 超时兜底，结果会让第二个进程在第一个进程只是因杀软扫描/网络卡顿跑得慢时抢走活锁，导致并发写同一个 253MB 二进制——两轮审查发现后撤回，回到更保守的"仅以 pid 存活与否为准"。

### 文档
- README 澄清 `scan` 里超长词典命中数的口径（是上限估计，不是精确预测）。
- `patcher.js` 补充 `rewriteRegion` 里"区间提前认领"设计取舍的说明（已知、当前无影响）。

## [0.1.0] - 2026-08-03

首个可用版本（未发布到 npm，仅支持 `git clone` 使用）。

- 核心引擎：对 Claude Code 原生二进制（Bun 编译单文件）做等长原地字节替换，零依赖、不解析 PE/Mach-O/ELF。
- 发现并修复"运行时真身是 JSC 预编译字节码"的架构级问题——此前全部替换实际生效数为 0；改为关闭字节码、走源码解析路线（代价：启动 +1s）。
- `--full` 全局长度预算引擎：把"每条译文必须等长"放宽为"源码区总长度不变"，短译文省下的字节供给超长译文使用。
- 字符串分段器 + 比较谓词守卫：替换严格限定在字符串字面量内，且不翻译 `.includes()`/`===`/`case` 里的比较谓词字符串（避免把 API 比较条件译成中文导致功能静默失效）。
- 原生常量池守卫、词边界守卫、运行时冒烟验证（`--version`/`doctor`/`mcp list` 实跑 + 乱码检测）等多层安全机制，经过四轮多智能体交叉审查加固。
- `test/selftest.js` 自测套件（零依赖，`node test/selftest.js`）。
