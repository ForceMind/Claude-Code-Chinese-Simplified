'use strict';
// 等长原地补丁引擎 —— 本工具的核心。
//
// 原理: Bun 单文件二进制内嵌的是 JS 源码文本, 运行时不校验其完整性(实证:
// 被 claude-code-zh-cn 重打包汉化过的 claude.exe 照常运行)。等长原地替换
// 是重打包的严格子集 —— 中文 UTF-8 写入槽位起始, 0x20 空格填充到英文原长,
// 文件字节长度不变、不动任何偏移表 → 无需解析 Bun 结构, 零依赖。
//
// 幂等/跟随新版: 始终从「纯英文备份」出发打补丁, 不增量叠加。
// target 是纯英文(新装或刚升级) → 刷新备份; 已汉化 → 用现有备份作源。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { isClaudeBinary, readVersion, healMissing, ASIDE_SUFFIX } = require('./locate');

const ROOT = path.resolve(__dirname, '..');
const DICT_PATH = path.join(ROOT, 'dict', 'zh-Hans.json');
const BACKUP_SUFFIX = '.cchans-backup';
const ZHCN_BACKUP_SUFFIX = '.zh-cn-backup'; // 兼容收编 claude-code-zh-cn 留下的备份

function loadDict() {
  return JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
}

// 已汉化检测: 统计「连续 >= minRun 个 CJK 字符(U+4E00-U+9FFF)」的串。
// 实测(2.1.190): 纯英文原版 7 处(内嵌库自带零星中文), 汉化版 >= 200 处。
// 阈值取 50, 与任何汉化工具的产物都兼容(不依赖本工具自己的词典)。
function countCjkRuns(buf, minRun, cap) {
  let runs = 0, cur = 0;
  for (let i = 0; i + 2 < buf.length;) {
    const b = buf[i];
    if (b >= 0xe4 && b <= 0xe9 && (buf[i + 1] & 0xc0) === 0x80 && (buf[i + 2] & 0xc0) === 0x80) {
      cur++;
      i += 3;
    } else {
      if (cur >= minRun) { runs++; if (runs >= cap) return runs; }
      cur = 0;
      i++;
    }
  }
  if (cur >= minRun) runs++;
  return runs;
}

function looksTranslated(buf) {
  return countCjkRuns(buf, 4, 50) >= 50;
}

// 解析出「纯英文源」buffer, 并维护备份。
// 误判防护: 覆盖旧备份前先字节比对, 不同则把旧备份保留为 .prev 而不是直接丢弃。
function resolveSource(target) {
  const backupPath = target + BACKUP_SUFFIX;
  const buf = fs.readFileSync(target);

  if (!looksTranslated(buf)) {
    // target 是纯英文 → 它就是源; 刷新备份(跟随升级)
    if (fs.existsSync(backupPath)) {
      const old = fs.readFileSync(backupPath);
      if (old.equals(buf)) return { source: buf, backupPath, refreshed: false };
      const prev = backupPath + '.prev';
      if (fs.existsSync(prev)) fs.unlinkSync(prev);
      fs.renameSync(backupPath, prev);
    }
    fs.writeFileSync(backupPath, buf); // 新建文件, 自然断开 install 时的硬链接
    return { source: buf, backupPath, refreshed: true };
  }

  // target 已汉化 → 必须有纯英文备份作源。
  // 必须校验备份完整(含 Bun 魔术串 + 体积下限): 若上次写备份时磁盘满而被截断,
  // 长度断言(比较的是 buf 与 source, 两者同源)照样通过, 加 --no-verify 就会把
  // 一个截断的二进制盖到 target 上, 且备份也已经是坏的 —— 只能重装。
  if (fs.existsSync(backupPath)) {
    if (!isClaudeBinary(backupPath)) {
      throw new Error('备份文件不完整(可能上次写盘中断被截断), 拒绝作为补丁源: ' + backupPath +
        '\n  请重装或升级 Claude Code 得到纯英文版本后重试。');
    }
    const b = fs.readFileSync(backupPath);
    if (!looksTranslated(b)) return { source: b, backupPath, refreshed: false };
    throw new Error('备份文件 ' + backupPath + ' 本身已被汉化, 不能作源。请重装/升级 Claude Code 后重试。');
  }
  const zhcnPath = target + ZHCN_BACKUP_SUFFIX;
  if (fs.existsSync(zhcnPath) && isClaudeBinary(zhcnPath)) { // 同样要校验完整性, 截断的备份不能当源
    const b = fs.readFileSync(zhcnPath);
    if (!looksTranslated(b)) {
      fs.writeFileSync(backupPath, b); // 收编为本工具的备份
      return { source: b, backupPath, refreshed: true };
    }
  }
  throw new Error(
    '目标已被汉化, 且找不到纯英文备份(' + backupPath + ')。\n' +
    '请重装或升级 Claude Code 得到纯英文版本后重试: npm install -g @anthropic-ai/claude-code'
  );
}

// 对 buffer 原地应用词典。dict 的 key 已按英文字节长度降序存储(build-dict 保证),
// 先替长串避免子串抢先命中导致错位。
//
// 词边界守卫(关键安全机制): 实证发现像 "Sandbox" 这类词条大量命中在压缩代码的
// 标识符/属性名内部(SandboxNetworkAccess、queryCancelledError), 若替换会被填充
// 空格劈开标识符 → 语法错误 → 二进制报废。故当 needle 边缘字节本身是标识符字符
// 时, 检查命中位置的相邻字节, 也是标识符字符则跳过该处。
// (" to cancel" 这类以空格/标点开头结尾的词条不受影响, 边缘本身就是边界。)
const isIdByte = b =>
  (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) ||
  (b >= 0x30 && b <= 0x39) || b === 0x5f || b === 0x24;

// 原生常量池守卫(第二道守卫, 2026-08-03 事故后新增, 详见 DEVELOPMENT-NOTES §十一)。
//
// 事故机理是「字符串尾部合并」: 链接器把短标识符与以它结尾的长消息**共享存储**——
// JSC 属性名 cancel 就是消息 "could not find stream to cancel" 的末 6 字节切片
// (实证: 整个 78-84MB 原生区内不存在独立的 \0cancel\0 表项)。于是覆写消息尾部
// = 直接摧毁属性名 -> claude 启动即 TypeError: ptr.cancel is not a function。
// 词边界守卫看的是命中点紧邻字节, 对这种情况完全无感。
//
// 判据(纯字节级, 不解析任何可执行格式, 与 Bun/CC 版本无关):
//   C/C++ 原生字面量池 = 「单个 NUL 分隔的紧凑短串」-> 邻域内孤立 NUL 密集;
//   而 Bun 存放 CC 自己的 JS 字符串用 {ptr,len} 结构, 周围是成串的 NUL 填充。
// 故: 邻域孤立 NUL >= MIN_ISOLATED 且不含长度 >= MAX_RUN 的 NUL 串 -> 判为原生池。
//
// 实测区分力(对 v2.1.220 全词典 4768 处命中): 精确标出事故元凶那一处(40 中 1),
// 界面文案零假阳性, 全词典共标出 37 处 / 9 条词条(均为 Bun/SQLite/JSC 内部串)。
// 注意它只覆盖「字符串表」这一类; 嵌在连续文本模板里的协议常量(如 WebSocket
// 握手头的 "Sec-WebSocket-Version: 13")周围没有 NUL, 抓不到, 那类走词典黑名单。
// 判据一「C 串表」: 命中所在的 NUL 分隔单元本身是可打印 ASCII, 且左右紧邻的单元
// 也都由**单个** NUL 分隔、同为可打印 ASCII —— 这正是 C/C++ 字面量池的形状。
const isPrintByte = b => (b >= 0x20 && b <= 0x7e) || b === 0x09;
const MAX_UNIT = 400;

function neighborIsCString(buf, sep, dir) {
  if (dir < 0) {
    if (sep <= 0 || buf[sep - 1] === 0) return false; // 不是单 NUL 分隔
    let s = sep - 1, n = 0;
    while (s > 0 && buf[s - 1] !== 0 && n < MAX_UNIT) { s--; n++; }
    if (s === 0 || s >= sep) return false;
    for (let i = s; i < sep; i++) if (!isPrintByte(buf[i])) return false;
    return true;
  }
  if (sep + 1 >= buf.length || buf[sep + 1] === 0) return false;
  let e = sep + 1, n = 0;
  while (e < buf.length && buf[e] !== 0 && n < MAX_UNIT) { e++; n++; }
  if (e >= buf.length || e <= sep + 1) return false;
  for (let i = sep + 1; i < e; i++) if (!isPrintByte(buf[i])) return false;
  return true;
}

function inCStringTable(buf, idx, len) {
  let s = idx, n = 0;
  while (s > 0 && buf[s - 1] !== 0 && n < MAX_UNIT) { s--; n++; }
  if (s === 0 || buf[s - 1] !== 0) return false;
  let e = idx + len; n = 0;
  while (e < buf.length && buf[e] !== 0 && n < MAX_UNIT) { e++; n++; }
  if (e >= buf.length || buf[e] !== 0) return false;
  for (let i = s; i < e; i++) if (!isPrintByte(buf[i])) return false;
  return neighborIsCString(buf, s - 1, -1) && neighborIsCString(buf, e, +1);
}

// 判据二「孤立 NUL 密集」: 邻域内单个 NUL 频繁出现且无长 NUL 串。覆盖判据一漏掉
// 的形状(单元里混了不可打印字节、或分隔符不止一个 NUL), 如 Bun REPL 帮助文本、
// JSC 堆转储模板、SQLite/PCRE2 消息表。
// 边界处理: 孤立 NUL 只统计「左右邻居都在窗口内」的, NUL 串长度按缓冲区真实长度
// 计(不被窗口截断)—— 否则会在窗口两端产生漏判/误判(2026-08-03 审查实证)。
const POOL_WIN = 40, POOL_MIN_ISOLATED = 3, POOL_MAX_RUN = 4;

function hasDenseIsolatedNuls(buf, idx, len) {
  const s = Math.max(0, idx - POOL_WIN);
  const e = Math.min(buf.length, idx + len + POOL_WIN);
  let isolated = 0;
  for (let i = s; i < e; i++) {
    if (buf[i] !== 0) continue;
    // 按真实缓冲区量测这一串 NUL 的长度, 不受窗口边界截断
    let a = i; while (a > 0 && buf[a - 1] === 0) a--;
    let b = i; while (b + 1 < buf.length && buf[b + 1] === 0) b++;
    const runLen = b - a + 1;
    if (runLen >= POOL_MAX_RUN) return false;
    if (runLen === 1 && i > s && i < e - 1) isolated++;
    i = b; // 跳过整串
  }
  return isolated >= POOL_MIN_ISOLATED;
}

// 两个判据各有盲区(实测: 判据一独有 16 处、判据二独有 8 处, 全部经人工核对确为
// Bun/SQLite/JSC/PCRE2 内部串), 故取并集。
function inNativePool(buf, idx, len) {
  return inCStringTable(buf, idx, len) || hasDenseIsolatedNuls(buf, idx, len);
}

function patchBuffer(buf, dict, onProgress) {
  const keys = Object.keys(dict);
  let keysHit = 0, occurrences = 0, boundarySkips = 0, poolSkips = 0;
  for (let k = 0; k < keys.length; k++) {
    const en = keys[k];
    const enBuf = Buffer.from(en, 'utf8');
    const zhBuf = Buffer.from(dict[en], 'utf8');
    if (zhBuf.length > enBuf.length) continue;
    if (zhBuf.includes(0)) continue; // 双保险: 译文含 NUL 会破坏原生池守卫依赖的不变式 // 词典保证不会, 双保险
    const guardPrev = isIdByte(enBuf[0]);
    const guardNext = isIdByte(enBuf[enBuf.length - 1]);
    let from = 0, hits = 0, idx;
    while ((idx = buf.indexOf(enBuf, from)) !== -1) {
      if ((guardPrev && idx > 0 && isIdByte(buf[idx - 1])) ||
          (guardNext && idx + enBuf.length < buf.length && isIdByte(buf[idx + enBuf.length]))) {
        boundarySkips++;
        from = idx + 1; // 命中在标识符内部, 跳过
        continue;
      }
      if (inNativePool(buf, idx, enBuf.length)) {
        poolSkips++;
        from = idx + enBuf.length; // 命中在原生字符串池, 跳过(可能被尾部合并引用)
        continue;
      }
      zhBuf.copy(buf, idx);
      buf.fill(0x20, idx + zhBuf.length, idx + enBuf.length); // 空格填充到原长
      hits++;
      from = idx + enBuf.length;
    }
    if (hits) { keysHit++; occurrences += hits; }
    if (onProgress && (k + 1) % 50 === 0) onProgress(k + 1, keys.length, keysHit);
  }
  return { keysHit, occurrences, boundarySkips, poolSkips };
}

// 同目录写临时文件再 rename(同盘保证原子性); rename 覆盖会让 target 指向新
// inode, 与 install 时的硬链接副本自然隔离。Windows 上目标被运行中的进程占用
// 时 rename 抛 EBUSY/EPERM, 转成友好提示。
// 零依赖同步 sleep(不引入 timers/promises 的异步改造)
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows 上 EACCES 多半是杀软/句柄占用(瞬时, 值得重试); POSIX 上它几乎总是
// 权限不足(root 拥有的 /usr/local/lib/node_modules 等), 重试纯属浪费且会误导用户。
const LOCK_CODES = process.platform === 'win32'
  ? new Set(['EBUSY', 'EPERM', 'EACCES'])
  : new Set(['EBUSY', 'ETXTBSY']);

// fs.writeFileSync 建出来的新文件是 0o666 & ~umask(POSIX 上通常 0644, 无执行位),
// 而 rename 不继承目标路径原有的权限位 —— 若不补执行位, 产物在 macOS/Linux 上
// 根本跑不起来(verifyRuntime 直接 EACCES, restore 还原出的 claude 也不可执行)。
// Windows 不看权限位, 所以这个洞此前一直没暴露。
function inheritExecMode(tmp, target) {
  if (process.platform === 'win32') return;
  let mode = 0o755;
  try { mode = fs.statSync(target).mode & 0o777; } catch {}
  // 只给"本来就有读权限"的身份补执行位, 不放宽可见范围:
  // 0700 -> 0700, 0644 -> 0755, 0755 -> 0755。
  // 直接 `mode | 0o111` 会把管理员刻意收紧的 0700 变成 0711, 让同机其他账号也能
  // 执行(Linux 上 --x 即可 execve), 违反管理员意图且 restore 修不回来。
  const wanted = mode | 0o100 | ((mode & 0o044) >> 2);
  try {
    fs.chmodSync(tmp, wanted);
  } catch (e) {
    throw new Error('无法给补丁产物设置执行权限(' + e.code + '): ' + tmp +
      '\n  没有执行位的产物无法运行。请检查目录权限, 或改用有写权限的安装位置。');
  }
}

// 尽力删除临时文件: 刚写出的 253MB exe 常被杀毒软件即时扫描而短暂锁住,
// 一次 unlink 失败就放弃会留下 253MB 垃圾, 故重试几次。
function removeQuietly(p, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try { fs.unlinkSync(p); return true; } catch (e) {
      if (e.code === 'ENOENT') return true;
      if (!LOCK_CODES.has(e.code) || i === attempts - 1) return false;
      sleepSync(300 * (i + 1));
    }
  }
  return false;
}

// 提交补丁产物, 两级策略:
//
// 快路径 —— 直接 rename 覆盖(同盘原子)。失败原因通常是瞬时占用: 杀毒软件正在
// 扫描刚写出的 253MB exe, 或运行中的 Claude Code 恰好持有句柄。先重试退避。
//
// 慢路径 —— 实测本机同时跑着 14 个 claude 进程(交互会话 + daemon 预热的后台
// worker)时, 重试多久都过不去。但 Windows 只禁止「删除/覆盖」运行中的 exe,
// 「改名」是允许的(映像仍按旧名挂着, 已在跑的进程不受影响)。于是先把旧文件
// 改名让位, 再把新文件放到原位 —— 这样用户不必关掉所有会话也能打补丁,
// 已运行的进程继续用旧映像, 新启动的才用新的。
// 让位后若放置失败一律回滚, 保证 target 任何时刻都存在, 绝不留下"没有 claude.exe"
// 的中间态。旧文件此刻多半仍被映射而删不掉, 留到下次 patch 再清, 不影响正确性。
function commitTmp(tmp, target, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(tmp, target);
      return { movedAside: false };
    } catch (e) {
      if (!LOCK_CODES.has(e.code)) { removeQuietly(tmp); throw e; }
      if (i < attempts - 1) sleepSync(500 * (i + 1));
    }
  }

  // aside 用唯一名: 固定名会在「上次热替换留下的 .cchans-old 仍被老进程映射」时
  // 撞上 EPERM(实测), 导致热替换只能连用一次 —— 而「不必关闭 Claude Code」正是
  // 它的卖点。带时间戳后每次让位都有独立槽位, 陈旧的由 cleanAside() 统一回收。
  const aside = target + ASIDE_SUFFIX + '.' + Date.now();
  try {
    fs.renameSync(target, aside);
  } catch (e) {
    removeQuietly(tmp);
    throw new Error(
      '目标文件被占用, 且无法为其改名让位(' + e.code + '): 请关闭所有正在运行的\n' +
      '  Claude Code(含后台会话, 可先跑 claude agents --json 查看), 再重新执行。\n' +
      '  你的 claude.exe 未被改动。'
    );
  }
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    // 回滚必须如实上报: 若回滚也失败, 此刻磁盘上没有 claude.exe, 谎称"未被改动"
    // 会让唯一能自救的用户放弃自救。必须把 aside 的绝对路径交给用户。
    let rolledBack = true;
    try { fs.renameSync(aside, target); } catch { rolledBack = false; }
    removeQuietly(tmp);
    if (rolledBack) {
      throw new Error('替换失败(已回滚, claude.exe 未被改动): ' + e.message);
    }
    throw new Error(
      '替换失败且回滚失败 —— 此刻 claude.exe 不存在, 请手动恢复:\n' +
      '    ' + (process.platform === 'win32' ? 'move /y ' : 'mv -f ') + '"' + aside + '" "' + target + '"\n' +
      '  原始错误: ' + e.message
    );
  }
  return { movedAside: !removeQuietly(aside, 2) };
}

// 回收所有陈旧的让位副本(每个都是一份完整二进制, 253MB 起步)。
// 仍被运行中的进程映射的删不掉, 留到下次再清即可。
function cleanAside(target) {
  const dir = path.dirname(target);
  const prefix = path.basename(target) + ASIDE_SUFFIX;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (n.startsWith(prefix)) removeQuietly(path.join(dir, n), 1);
  }
}

// 自愈实现放在 locate.js(见那里的注释: CLI 先 locate 再进 patcher, 放这里是死代码),
// 此处仅复用, 保证两条入口行为一致。
const healInterrupted = healMissing;

function atomicWrite(target, buf) {
  const tmp = target + '.cchans-tmp';
  try {
    fs.writeFileSync(tmp, buf);
    inheritExecMode(tmp, target);
  } catch (e) {
    removeQuietly(tmp);
    throw e;
  }
  return commitTmp(tmp, target);
}

// 运行时冒烟验证 —— 本工具最重要的安全网(2026-08-03 血的教训, 详见 §十一)。
//
// 补丁扫的是整个二进制, 除 Claude Code 自己的 JS 外, 还会扫到 Bun 运行时的原生
// 标识符表和第三方库(SQLite/ripgrep/ICU…)的数据区。实证: " to cancel" 的一处命中
// 落在 Bun 原生标识符表, 覆写后启动即 TypeError: ptr.cancel is not a function ——
// 而长度断言、词边界守卫、对 cli.js 的 JS 语法检查全都发现不了这类破坏。
//
// 结论: 只有「产物真跑通」才算补丁成功。跑通前绝不覆盖用户的 claude.exe。
// 用独立的 CLAUDE_CONFIG_DIR, 避免验证过程污染用户的真实会话/daemon 状态。
// 不含 /Bun v\d/: 实测复现事故产物时崩溃输出里并没有 Bun 版本横幅, 退出码 1 已足够
// 抓住; 而若将来某版 doctor 在正常输出里打印 Bun 运行时版本, 这条会让所有人打不了
// 补丁 —— 留着是纯风险没有收益。
const CRASH_RE = /is not a function|panic:|Segmentation fault|Illegal instruction/i;
// --version 太浅(实测: 只坏了那一处的产物照样 status=0 通过), 必须叠加走完整启动
// 路径的命令。三条都实测过: 不需要登录、无副作用、在纯英文与汉化产物上均 status=0,
// 在事故产物上均能判失败。
const SMOKE_ARGS = [['--version'], ['doctor'], ['mcp', 'list']];

function verifyRuntime(exePath) {
  let cfg;
  try {
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cchans-verify-'));
  } catch (e) {
    return { ok: false, reason: '无法创建临时配置目录: ' + e.message };
  }
  // 剥掉会让子进程以为"自己跑在 Claude Code 里"的继承变量(README 主推的用法恰恰
  // 是在 CC 内部跑 patch), 并显式关掉自动更新器 —— 验证过程绝不能让 CC 在打补丁
  // 中途把 claude.exe 换成新版(§十 记录过 daemon 自更新打架的前科)。
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, DISABLE_AUTOUPDATER: '1' };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  }
  try {
    for (const args of SMOKE_ARGS) {
      const label = args.join(' ');
      const r = spawnSync(exePath, args, {
        env, encoding: 'utf8', timeout: 120000, windowsHide: true,
      });
      if (r.error) {
        return { ok: false, kind: 'spawn', reason: label + ' 无法运行: ' + r.error.message };
      }
      const out = ((r.stdout || '') + (r.stderr || '')).trim();
      const firstLine = out.split('\n')[0] || '(无输出)';
      if (CRASH_RE.test(out)) {
        return { ok: false, kind: 'crash', reason: label + ' 输出含崩溃特征: ' + firstLine };
      }
      if (r.status !== 0) {
        return { ok: false, kind: 'exit', reason: label + ' 退出码 ' + r.status + ': ' + firstLine };
      }
    }
    return { ok: true };
  } finally {
    try { fs.rmSync(cfg, { recursive: true, force: true }); } catch {}
  }
}

// macOS: 改写二进制会使代码签名失效, Apple Silicon 内核会直接 SIGKILL 拒绝
// 运行 → 补丁后必须重新 ad-hoc 签名(codesign 是系统自带工具, 仍零依赖)。
// restore 不需要: 备份与原始签名版字节一致, 还原即恢复有效签名。
function resignIfDarwin(target) {
  if (process.platform !== 'darwin') return null;
  try {
    execFileSync('codesign', ['--force', '--sign', '-', target], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function patch(target, opts = {}) {
  const healed = healInterrupted(target); // 必须在 isClaudeBinary 之前
  if (!isClaudeBinary(target)) {
    throw new Error('不是有效的 Claude Code 二进制(缺少 Bun 魔术串或体积过小): ' + target);
  }
  const dict = loadDict();
  removeQuietly(target + '.cchans-tmp', 1); // 回收上次写盘失败留下的半成品
  // 注意顺序: cleanAside 必须在 resolveSource **之后**。让位副本可能是用户手上
  // 最后一份纯英文原版(例如备份被误删), 先删再发现没有可用源就无法挽回了
  // (2026-08-03 审查实证)。
  const { source, refreshed } = resolveSource(target);
  cleanAside(target); // 已确认拿到可用的纯英文源, 此时回收陈旧让位副本才安全
  const buf = Buffer.from(source); // 副本, 不动源
  const t0 = Date.now();
  const stats = patchBuffer(buf, dict, opts.onProgress);
  if (buf.length !== source.length) {
    throw new Error('内部错误: 补丁改变了文件长度(' + source.length + ' -> ' + buf.length + '), 已中止写入。');
  }
  if (stats.keysHit === 0) {
    throw new Error('没有任何词条命中 —— 词典可能与该版本完全不匹配, 已中止写入。请运行 scan 诊断。');
  }
  // 先落临时文件 → (macOS 重签名) → 实跑验证 → 通过才 rename 覆盖 target。
  // 验证不通过时 target 保持原样, 用户环境不受任何影响。
  const tmp = target + '.cchans-tmp';
  let resigned = null;
  let verified = null;
  try {
    fs.writeFileSync(tmp, buf); // 必须在 try 内: 磁盘满时才不会留下 253MB 残骸
    inheritExecMode(tmp, target);
    resigned = resignIfDarwin(tmp);
    if (resigned === false) {
      // 签名无效的二进制在 Apple Silicon 上会被内核 SIGKILL, 验证必然失败。
      // 若不在此单独抛出, 用户拿到的会是"词典破坏了二进制"这种完全错误的诊断。
      throw new Error(
        'macOS 重签名失败(codesign 不可用或被拒), 已中止, 你的 claude 未被改动。\n' +
        '  请确认已安装 Xcode Command Line Tools: xcode-select --install'
      );
    }
    if (opts.verify !== false) {
      if (opts.onVerify) opts.onVerify();
      const v = verifyRuntime(tmp);
      verified = v.ok;
      if (!v.ok) {
        // 归因要诚实: 只有 kind==='crash' 才有把握说是词典破坏了二进制。
        // spawn/exit 失败更可能是杀软拦截、权限、环境问题, 一口咬定"词典有问题"
        // 会把用户引向错误的方向, 还会给上游带来一批伪 issue。
        const cause = v.kind === 'crash'
          ? '  产物确实崩溃了 —— 词典里有条目破坏了二进制(通常是命中了 Bun 运行时/\n' +
            '  第三方库的数据区)。请到 GitHub 提 issue 并附上本条信息。'
          : '  注意: 这未必是词典的问题 —— 也可能是杀毒软件拦截了刚写出的临时文件、\n' +
            '  权限不足, 或运行环境异常。可先重试一次; 确认是词典问题再提 issue。';
        throw new Error(
          '补丁产物运行验证失败: ' + v.reason + '\n' +
          '  已中止写入, 你的 claude.exe 未被改动(仍是打补丁前的状态)。\n' + cause + '\n' +
          '  仓库: ForceMind/Claude-Code-Chinese-Simplified'
        );
      }
    }
  } catch (e) {
    removeQuietly(tmp);
    throw e;
  }
  const commit = commitTmp(tmp, target);
  return {
    healed,                        // true=自愈了上次中断留下的缺失 target
    movedAside: commit.movedAside, // true=旧映像仍在运行, 暂留 .cchans-old.<时间戳>
    keysHit: stats.keysHit,
    occurrences: stats.occurrences,
    boundarySkips: stats.boundarySkips,
    poolSkips: stats.poolSkips,
    dictTotal: Object.keys(dict).length,
    backupRefreshed: refreshed,
    seconds: (Date.now() - t0) / 1000,
    version: readVersion(target),
    resigned, // null=非 macOS, true=已重签名, false=重签名失败
    verified, // true=实跑验证通过, null=跳过验证
  };
}

function restore(target) {
  const healed = healInterrupted(target);
  const backupPath = target + BACKUP_SUFFIX;
  if (!fs.existsSync(backupPath)) {
    throw new Error('找不到备份: ' + backupPath);
  }
  if (!isClaudeBinary(backupPath)) {
    throw new Error('备份文件不是完整的 Claude Code 二进制(可能上次写盘中断被截断), 拒绝还原: ' + backupPath);
  }
  const buf = fs.readFileSync(backupPath);
  if (looksTranslated(buf)) {
    throw new Error('备份文件本身已被汉化, 拒绝还原(会覆盖不掉中文)。请重装 Claude Code。');
  }
  cleanAside(target);
  const commit = atomicWrite(target, buf);
  return { restoredFrom: backupPath, healed, movedAside: commit.movedAside };
}

function status(target) {
  const backupPath = target + BACKUP_SUFFIX;
  const buf = fs.readFileSync(target);
  return {
    target,
    version: readVersion(target),
    size: buf.length,
    translated: looksTranslated(buf),
    hasBackup: fs.existsSync(backupPath),
    hasZhCnBackup: fs.existsSync(target + ZHCN_BACKUP_SUFFIX),
  };
}

module.exports = {
  loadDict, looksTranslated, countCjkRuns, resolveSource,
  patchBuffer, atomicWrite, patch, restore, status, resignIfDarwin,
  verifyRuntime, BACKUP_SUFFIX, DICT_PATH,
};
