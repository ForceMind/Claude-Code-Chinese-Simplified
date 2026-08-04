'use strict';
// 等长原地补丁引擎 —— 本工具的核心。
//
// 原理: Bun 单文件二进制内嵌的是 JS 源码文本, 运行时不校验其完整性(实证:
// 被 claude-code-zh-cn 重打包汉化过的 claude.exe 照常运行)。等长原地替换
// 是重打包的严格子集 —— 中文 UTF-8 写入槽位起始, 0x20 空格填充到英文原长,
// 文件字节长度不变、不动偏移表、零依赖。会解析 Bun 模块表的**最外层**(纯字节
// 算术, 见 bunfmt.js): 把替换限定在主模块 JS 源码区、关掉 JSC 字节码、把源码
// 编码字段改为 UTF-8 —— 缺任何一步, 替换要么不生效要么必然乱码(§十三)。
//
// 幂等/跟随新版: 始终从「纯英文备份」出发打补丁, 不增量叠加。
// target 是纯英文(新装或刚升级) → 刷新备份; 已汉化 → 用现有备份作源。

const fs = require('fs');
const wfs = require('./wfs'); // 长路径安全的 fs 子集(见 src/winpath.js 注释)
const { toLongPath } = require('./winpath');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { isClaudeBinary, readVersion, healMissing, ASIDE_SUFFIX } = require('./locate');
const bunfmt = require('./bunfmt');

const ROOT = path.resolve(__dirname, '..');
const DICT_PATH = path.join(ROOT, 'dict', 'zh-Hans.json');
const BACKUP_SUFFIX = '.cchans-backup';
const ZHCN_BACKUP_SUFFIX = '.zh-cn-backup'; // 兼容收编 claude-code-zh-cn 留下的备份

function loadDict() {
  return JSON.parse(wfs.readFileSync(DICT_PATH, 'utf8'));
}

// 备份完整性锚。isClaudeBinary 只查体积 + 尾部魔术串, 拦得住"被截断", 拦不住
// "体积和尾串都完好、但中段损坏"—— 实测这种备份配上 --no-verify 会让段错误的
// 二进制盖掉用户唯一的 claude.exe, 且备份同时失效, 只能重装(审查实证)。
// 故写备份时同步落一份 sha256 旁文件, 用它作源之前先校验。253MB 算一次约 1s。
const SHA_SUFFIX = '.sha256';

function sha256(buf) {
  return require('crypto').createHash('sha256').update(buf).digest('hex');
}

function writeBackup(backupPath, buf) {
  wfs.writeFileSync(backupPath, buf);
  try { wfs.writeFileSync(backupPath + SHA_SUFFIX, sha256(buf)); } catch {}
}

// 返回 true=校验通过或无锚可校验; false=锚存在且对不上(备份已损坏)
function backupIntact(backupPath, buf) {
  let want;
  try { want = wfs.readFileSync(backupPath + SHA_SUFFIX, 'utf8').trim(); } catch { return true; }
  if (!/^[0-9a-f]{64}$/.test(want)) return true;
  return sha256(buf) === want;
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
  const buf = wfs.readFileSync(target);

  if (!looksTranslated(buf)) {
    // target 是纯英文 → 它就是源; 刷新备份(跟随升级)
    if (wfs.existsSync(backupPath)) {
      const old = wfs.readFileSync(backupPath);
      if (old.equals(buf)) {
        try { if (!wfs.existsSync(backupPath + SHA_SUFFIX)) wfs.writeFileSync(backupPath + SHA_SUFFIX, sha256(old)); } catch {}
        return { source: buf, backupPath, refreshed: false };
      }
      // 旧备份保留为 .prev, 作为 resolveSource 找不到可用备份时的兜底源(见下方)
      const prev = backupPath + '.prev';
      removeQuietly(prev, 2);
      try {
        wfs.renameSync(backupPath, prev);
        if (wfs.existsSync(backupPath + SHA_SUFFIX)) wfs.renameSync(backupPath + SHA_SUFFIX, prev + SHA_SUFFIX);
      } catch {}
    }
    writeBackup(backupPath, buf); // 新建文件, 自然断开 install 时的硬链接
    return { source: buf, backupPath, refreshed: true };
  }

  // target 已汉化 → 必须有纯英文备份作源。
  // 必须校验备份完整(含 Bun 魔术串 + 体积下限): 若上次写备份时磁盘满而被截断,
  // 长度断言(比较的是 buf 与 source, 两者同源)照样通过, 加 --no-verify 就会把
  // 一个截断的二进制盖到 target 上, 且备份也已经是坏的 —— 只能重装。
  // 候选源: 本工具备份 → claude-code-zh-cn 的备份(迁移场景)。
  //
  // **绝不把 .prev 放进这条链**: .prev 按构造就是「上一个版本」的备份(CC 升级时
  // 旧备份被轮转过去), 拿它作源会把用户的 claude 静默降级 —— 而且降级抓不出来:
  // readVersion 读的是二进制旁边的 package.json(npm 包元数据), 降级后 status 照样
  // 显示新版本号; verifyRuntime 也拦不住(旧版本身跑得好好的); 更糟的是旧版还会被
  // 扶正成唯一基线, 此后 restore 也只能还原到旧版。三路审查独立复现(2026-08-03)。
  // 找不到可用备份时宁可诚实报错让用户重装 —— 那只是一条 npm 命令。
  const targetSize = buf.length;
  const wantVer = readVersion(target);
  for (const cand of [backupPath, target + ZHCN_BACKUP_SUFFIX]) {
    if (!wfs.existsSync(cand) || !isClaudeBinary(cand)) continue; // 截断/非二进制
    const b = wfs.readFileSync(cand);
    if (!backupIntact(cand, b)) continue;     // 体积尾串都对但中段损坏
    if (looksTranslated(b)) {
      if (cand === backupPath) {
        throw new Error('备份文件 ' + backupPath + ' 本身已被汉化, 不能作源。请重装/升级 Claude Code 后重试。');
      }
      continue;
    }
    // 源合法性闸门: 等长替换的前提就是「源与 target 同一份二进制」。
    // zh-cn 备份来自会重打包的工具, 体积天然可能不等, 对它只查版本水印。
    if (cand !== target + ZHCN_BACKUP_SUFFIX && b.length !== targetSize) {
      throw new Error('备份与当前 claude 体积不一致(' + b.length + ' vs ' + targetSize + '), 拒绝作源: ' + cand +
        '\n  这通常意味着备份来自其他版本。请重装/升级 Claude Code 后重试。');
    }
    if (wantVer && !b.includes(Buffer.from(wantVer, 'utf8'))) {
      throw new Error('备份里找不到当前版本水印 ' + wantVer + ', 拒绝作源(避免把 claude 静默降级): ' + cand +
        '\n  请重装/升级 Claude Code 后重试: npm install -g @anthropic-ai/claude-code');
    }
    if (cand !== backupPath) writeBackup(backupPath, b); // 收编为本工具的备份
    return { source: b, backupPath, refreshed: cand !== backupPath, sourceFrom: cand };
  }
  const prev = backupPath + '.prev';
  const prevHint = wfs.existsSync(prev)
    ? '\n  同目录存在上一版本的备份 ' + prev + '\n' +
      '  它很可能是**旧版本**的字节, 本工具不会自动使用(会把你的 claude 静默降级)。\n' +
      '  确认版本无误后可手动改名为 ' + path.basename(backupPath) + ' 再重试。'
    : '';
  throw new Error(
    '目标已被汉化, 且找不到可用的纯英文备份(' + backupPath + ')。\n' +
    '  请重装或升级 Claude Code 得到纯英文版本后重试: npm install -g @anthropic-ai/claude-code' + prevHint
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

// opts.segs: 传入 stringSegments 结果时, 追加两道结构性守卫 ——
//   (1) 只在字符串字面量文本内替换; (2) 跳过比较谓词字符串。
// patchLocked 的真实路径始终传入; 合成测试可不传(保持字节级语义可单测)。
function patchBuffer(buf, dict, onProgress, opts = {}) {
  const segs = opts.segs || null;
  // 长词条优先(与 --full 引擎的 rewriteRegion 一致): 词典近似按字母序排列,
  // 短语条目(如 "Sandbox")常是长句条目(如 "Sandbox is not enabled")的前缀。
  // 若按原始顺序处理, 短条目先吃掉长句开头几个字节, 长条目随后 indexOf 落空,
  // 产出"半句中文半句英文"的割裂文案。长词条先处理可让完整短语先被认领,
  // 之后短条目的 indexOf 天然找不到已被替换的字节, 只命中真正独立的短语出现。
  const keys = Object.keys(dict).sort((a, b) => Buffer.byteLength(b) - Buffer.byteLength(a));
  let keysHit = 0, occurrences = 0, boundarySkips = 0, poolSkips = 0, codeSkips = 0, cmpSkips = 0;
  for (let k = 0; k < keys.length; k++) {
    const en = keys[k];
    const enBuf = Buffer.from(en, 'utf8');
    const zhBuf = Buffer.from(dict[en], 'utf8');
    if (zhBuf.length > enBuf.length) continue;
    if (zhBuf.includes(0)) continue; // 双保险: 译文含 NUL 会破坏原生池守卫依赖的不变式
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
      if (segs) {
        const seg = findSegment(segs, idx, idx + enBuf.length);
        if (!seg) { codeSkips++; from = idx + enBuf.length; continue; }
        if (isComparisonString(buf, seg)) { cmpSkips++; from = idx + enBuf.length; continue; }
      }
      zhBuf.copy(buf, idx);
      buf.fill(0x20, idx + zhBuf.length, idx + enBuf.length); // 空格填充到原长
      hits++;
      from = idx + enBuf.length;
    }
    if (hits) { keysHit++; occurrences += hits; }
    if (onProgress && (k + 1) % 50 === 0) onProgress(k + 1, keys.length, keysHit);
  }
  return { keysHit, occurrences, boundarySkips, poolSkips, codeSkips, cmpSkips };
}

// JS 字符串字面量分段器 —— --full 引擎的结构性守卫。
//
// 为什么需要: 超长词典(oversize.json)的 477 条从未被实际应用过, 首次全量放入时
// 实测有条目命中了**字符串字面量之外**的代码位置, 全角冒号落进代码 = SyntaxError
// (被运行时验证当场拦下)。逐条拉黑是打地鼠, 结构性修法是: 只允许替换落在
// '…' / "…" / 模板字面量文本段 内部。
//
// 失败方向安全: 分段器把字符串误判成代码 → 跳过该处 → 少翻一条, 永不破坏语法;
// 反向误判(代码判成字符串)理论上可能 → 但产物过不了实跑验证, 不会落地。
// 源码区是 100% ASCII(实证), 按字节扫描即可。regex/除号歧义用标准启发式:
// 前一个有效字节是 标识符/)/]/}/. 之一 → 除号, 否则 → 正则起始。
function stringSegments(buf) {
  const segs = [];           // [start,end) 均为"字符串文本"字节区间(不含引号本身)
  const n = buf.length;
  // 模板嵌套栈: 每进入一层 \${ 表达式压入一个花括号深度计数。
  // 必须按深度配对: \${cond?{a:1}:b} 里第一个 } 关的是对象字面量, 不是模板表达式
  // (2026-08-04 实证: 不配对会在 JSON 解析器一类的代码上引发千字节级状态错位)。
  const stack = [];
  let i = 0, prevSig = 0;    // prevSig = 上一个有效(非空白)字节, 用于 regex 判定
  let idStart = -1;          // 当前标识符跑的起点(用于识别 return 等关键字后的正则)
  const isReSafePrev = b =>  // 这些字节之后的 '/' 是除号
    (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) ||
    b === 0x5f || b === 0x24 || b === 0x29 || b === 0x5d || b === 0x7d || b === 0x2e;
  // 这些关键字之后的 '/' 是正则(minified 里 return/^a/.test(x) 很常见)
  const RE_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'instanceof',
    'new', 'delete', 'void', 'throw', 'do', 'else', 'yield', 'await']);

  function scanTemplateText() {                  // 从 i 起扫模板文本, 返回后 i 停在 ` 或 ${ 之后
    let s = i;
    while (i < n) {
      const t = buf[i];
      if (t === 0x5c) { i += 2; continue; }
      if (t === 0x60) { segs.push([s, i]); prevSig = 0x60; i++; return; }
      if (t === 0x24 && buf[i + 1] === 0x7b) { segs.push([s, i]); stack.push(0); i += 2; return; }
      i++;
    }
    segs.push([s, n]);
  }

  while (i < n) {
    const c = buf[i];
    if (c === 0x27 || c === 0x22) {              // ' 或 "
      const q = c, s = i + 1;
      i++;
      while (i < n && buf[i] !== q) { if (buf[i] === 0x5c) i++; i++; }
      segs.push([s, Math.min(i, n)]);
      prevSig = q; idStart = -1; i++;
      continue;
    }
    if (c === 0x60) {                            // ` 模板起始
      i++;
      scanTemplateText();
      continue;
    }
    if (c === 0x7b) {                            // { : 在模板表达式内要计深度
      if (stack.length) stack[stack.length - 1]++;
      prevSig = c; idStart = -1; i++;
      continue;
    }
    if (c === 0x7d) {                            // }
      if (stack.length) {
        if (stack[stack.length - 1] === 0) {     // 模板表达式结束, 回到模板文本
          stack.pop();
          i++;
          scanTemplateText();
          continue;
        }
        stack[stack.length - 1]--;
      }
      prevSig = c; idStart = -1; i++;
      continue;
    }
    if (c === 0x2f) {                            // /
      const d = buf[i + 1];
      if (d === 0x2f) { i += 2; while (i < n && buf[i] !== 0x0a) i++; continue; }        // 行注释
      if (d === 0x2a) { i += 2; while (i + 1 < n && !(buf[i] === 0x2a && buf[i + 1] === 0x2f)) i++; i += 2; continue; } // 块注释
      let isRegex = !isReSafePrev(prevSig);
      if (!isRegex && idStart >= 0) {            // prevSig 是标识符字符: 看整个词是不是关键字
        isRegex = RE_KEYWORDS.has(buf.slice(idStart, i).toString('latin1').trim());
      }
      if (isRegex) {                             // 正则字面量
        i++;
        let inClass = false;
        while (i < n) {
          const t = buf[i];
          if (t === 0x5c) { i += 2; continue; }
          if (t === 0x5b) inClass = true;
          else if (t === 0x5d) inClass = false;
          else if (t === 0x2f && !inClass) break;
          else if (t === 0x0a) break;            // 容错: 换行终止
          i++;
        }
        prevSig = 0x2f; idStart = -1; i++;
        continue;
      }
      prevSig = c; idStart = -1; i++;
      continue;
    }
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
      // 维护标识符跑: 用于关键字判定
      const isIdc = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ||
                    (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x24;
      if (isIdc) { if (idStart < 0) idStart = i; } else idStart = -1;
      prevSig = c;
    } else {
      // 空白结束一个标识符跑(return /re/ 中间有空格)
      if (idStart >= 0 && !RE_KEYWORDS.has(buf.slice(idStart, i).toString('latin1'))) idStart = -1;
    }
    i++;
  }
  return segs;
}

// 判定 [s,e) 是否完整落在某个字符串文本段内(segs 已按 start 有序)。
// 返回所在段, 未落入返回 null。
function findSegment(segs, s, e) {
  let lo = 0, hi = segs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (segs[mid][0] <= s) lo = mid + 1; else hi = mid; }
  return (lo > 0 && segs[lo - 1][1] >= e) ? segs[lo - 1] : null;
}
function insideString(segs, s, e) { return findSegment(segs, s, e) !== null; }

// 比较谓词守卫 —— 与"显示用字符串"同为字面量、却绝不能翻的另一类:
//   e.includes("Usage credits are required…") / x === "not found" / case "…":
// API/系统返回的是英文, 把谓词字符串译成中文后条件永远为假 → **功能静默失效**
// (审查实证: 已部署产物里长上下文计费错误的识别路径因此废掉)。
// 判据: 字符串开引号前紧邻 includes(/startsWith(/endsWith(/indexOf(/match(/split(
// 或比较运算符或 case; 闭引号后紧跟比较运算符。命中任一 → 整段不译。
// 审查实证收紧(2026-08-04): minified 源里 case"(无空格) 464 处 vs case "(带空格)
// 仅 25 处——旧版只认后者, 95% 的 case 标签不受守卫; === 前后也常见贴身空格
// (=== "x" / "x" === y); 接收者位置的谓词("字面量".includes(x))原来完全不设防。
const CMP_BEFORE = /(?:\.(?:includes|startsWith|endsWith|indexOf|match|split)\(|[!=]==?|(?:^|[^A-Za-z0-9_$])case)\s*$/;
const CMP_AFTER = /^\s*(?:[!=]==?|\.(?:includes|startsWith|endsWith|indexOf|match|split)\()/;

function isComparisonString(region, seg) {
  const [s, e] = seg;
  const before = region.slice(Math.max(0, s - 20), Math.max(0, s - 1)).toString('latin1');
  if (CMP_BEFORE.test(before)) return true;
  const after = region.slice(e + 1, Math.min(region.length, e + 14)).toString('latin1');
  return CMP_AFTER.test(after);
}

// 全局长度预算重写引擎(--full, 实验特性)。
//
// 把约束从「每条译文必须等长」放宽为「整个 JS 源码区总长度不变」:
// 短译文不再逐条用空格填满槽位, 省下的字节汇成全局预算, 用来容纳超长译文
// (oversize.json 里那些"中文比英文长"的条目); 整体重排后若仍比原区短,
// 在区末补 ASCII 空格凑回原长(区末是行注释/语句边界, 补空格语法无害)。
// 模块表里 contents 的 {offset,length} 一个字节都不用动, 仍不解析 PE/Mach-O/ELF。
//
// 实测(v2.1.220 + 当前词典): 安全条目省 9683 字节, 全部 387 条可命中的超长
// 条目只需 5138 字节, 净余 4545 —— 这一版能全量容纳。若未来某版预算不足,
// 按「单条总增量」从贵到贱整条放弃(同一条文案要么全译要么全不译, 不出现
// 同一句话在 A 处中文 B 处英文的割裂)。
//
// 守卫与等长路径完全一致: 词边界 + 原生池 + NUL 校验 + 长串优先认领不重叠。
function rewriteRegion(region, safeDict, overDict, onProgress) {
  const segs = stringSegments(region); // 结构性守卫: 只在字符串字面量文本内替换
  const entries = [];
  for (const [en, zh] of Object.entries(safeDict)) entries.push({ en, zh, over: false });
  for (const [en, zh] of Object.entries(overDict)) entries.push({ en, zh, over: true });
  entries.sort((a, b) => Buffer.byteLength(b.en) - Buffer.byteLength(a.en));

  // 认领区间(有序数组 + 二分插入, 避免 O(n^2) 线性扫)
  const starts = [], ends = [];
  function overlaps(s, e) {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < e) lo = mid + 1; else hi = mid; }
    // lo = 第一个 start >= e 的位置; 检查它前面那个区间是否越过 s
    return lo > 0 && ends[lo - 1] > s;
  }
  function claim(s, e) {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < s) lo = mid + 1; else hi = mid; }
    starts.splice(lo, 0, s); ends.splice(lo, 0, e);
  }

  const stats = { keysHit: 0, occurrences: 0, boundarySkips: 0, poolSkips: 0,
                  overEntries: 0, overOccurrences: 0, overDropped: 0, slack: 0 };
  const matches = [];         // 已接受: {start, end, zhBuf}
  const overCandidates = [];  // 超长条目暂存, 预算通过后才接受
  let budget = 0;             // 安全条目省出来的字节

  for (let k = 0; k < entries.length; k++) {
    const it = entries[k];
    const enBuf = Buffer.from(it.en, 'utf8');
    const zhBuf = Buffer.from(it.zh, 'utf8');
    if (zhBuf.includes(0)) continue;
    // safeDict 按约定不含超长条目(build-dict 已过滤), 这里补一道跳过双保险:
    // 若上游误混入超长安全词条, 静默吃预算比"跳过"更危险(审查实证: 极端下
    // 可触发拼接长度断言中止写入)——两个来源(safe/over)都必须守住这条规则。
    if (!it.over && zhBuf.length > enBuf.length) continue;
    const guardPrev = isIdByte(enBuf[0]);
    const guardNext = isIdByte(enBuf[enBuf.length - 1]);
    let from = 0, idx;
    const found = [];
    while ((idx = region.indexOf(enBuf, from)) !== -1) {
      if ((guardPrev && idx > 0 && isIdByte(region[idx - 1])) ||
          (guardNext && idx + enBuf.length < region.length && isIdByte(region[idx + enBuf.length]))) {
        stats.boundarySkips++; from = idx + 1; continue;
      }
      if (inNativePool(region, idx, enBuf.length)) {
        stats.poolSkips++; from = idx + enBuf.length; continue;
      }
      const seg = findSegment(segs, idx, idx + enBuf.length);
      if (!seg) {
        stats.codeSkips = (stats.codeSkips || 0) + 1; // 字符串字面量之外, 跳过
        from = idx + enBuf.length; continue;
      }
      if (isComparisonString(region, seg)) {
        stats.cmpSkips = (stats.cmpSkips || 0) + 1;   // 比较谓词字符串, 跳过
        from = idx + enBuf.length; continue;
      }
      if (overlaps(idx, idx + enBuf.length)) { from = idx + enBuf.length; continue; }
      claim(idx, idx + enBuf.length);
      found.push(idx);
      from = idx + enBuf.length;
    }
    if (!found.length) continue;
    const delta = zhBuf.length - enBuf.length;
    if (!it.over) {
      budget += (-delta) * found.length;
      stats.keysHit++; stats.occurrences += found.length;
      for (const s of found) matches.push({ start: s, end: s + enBuf.length, zhBuf });
    } else {
      overCandidates.push({ zhBuf, enLen: enBuf.length, found, cost: delta * found.length });
    }
    if (onProgress && (k + 1) % 50 === 0) onProgress(k + 1, entries.length, stats.keysHit);
  }

  // 预算分配: 便宜的先进, 装不下的整条放弃(保证同一文案全译或全不译)
  overCandidates.sort((a, b) => a.cost - b.cost);
  for (const c of overCandidates) {
    if (c.cost > budget) { stats.overDropped++; continue; }
    budget -= c.cost;
    stats.overEntries++; stats.overOccurrences += c.found.length;
    stats.occurrences += c.found.length;
    for (const s of c.found) matches.push({ start: s, end: s + c.enLen, zhBuf: c.zhBuf });
  }
  stats.slack = budget;

  // 按位置拼接(被放弃的超长命中不在 matches 里, 自动保留英文原文)
  matches.sort((a, b) => a.start - b.start);
  const parts = [];
  let cursor = 0;
  for (const mt of matches) {
    parts.push(region.subarray(cursor, mt.start), mt.zhBuf);
    cursor = mt.end;
  }
  parts.push(region.subarray(cursor));
  let out = Buffer.concat(parts);
  if (out.length > region.length) {
    throw new Error('内部错误: 预算核算与拼接结果不一致(' + out.length + ' > ' + region.length + '), 已中止。');
  }
  if (out.length < region.length) {
    out = Buffer.concat([out, Buffer.alloc(region.length - out.length, 0x20)]);
  }
  return { buf: out, stats };
}

function loadOversize() {
  const p = path.join(ROOT, 'dict', 'oversize.json');
  try { return JSON.parse(wfs.readFileSync(p, 'utf8')); } catch { return {}; }
}

// 同目录写临时文件再 rename(同盘保证原子性); rename 覆盖会让 target 指向新
// inode, 与 install 时的硬链接副本自然隔离。Windows 上目标被运行中的进程占用
// 时 rename 抛 EBUSY/EPERM, 转成友好提示。
// 零依赖同步 sleep(不引入 timers/promises 的异步改造)
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 临时文件名带 pid: 此前全局共用一个 `.cchans-tmp`, 两个 cchans 并发时,
// 后写的进程会把先写的内容顶掉, 而先写的进程照样 rename 并报告"成功" ——
// 实测出现过「A 报成功, 落地的却是 B 的字节」(审查实证)。
const tmpPathFor = target => target + '.cchans-tmp.' + process.pid;

// 跨进程互斥: 同一个 target 同时只允许一个 cchans 改写。
// 用 'wx' 独占创建锁文件, 零依赖且跨平台。陈旧锁(进程已死)立即可接管。
const LOCK_SUFFIX = '.cchans-lock';

// 判断锁文件记录的 pid 是否还活着。signal 0 只做权限/存在性探测, 不真的发信号。
// ESRCH = 进程不存在; EPERM = 存在但不属于当前用户(视为活着, 保守)。
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

// 2026-08-04 教训(两轮独立审查复现): 曾经尝试给这里加一条"mtime 超过
// 30 分钟就无条件允许接管, 不管 pid 是否存活"的兜底, 想解决"锁文件里的 pid
// 被系统复用给另一个无关存活进程, 导致陈旧锁永远抢不回来"这个边缘情况。
// 结果引入了更严重的反向风险: 任何一次正常操作只要因为杀软扫描/网络卡顿/
// 磁盘慢跑过 30 分钟, 第二个进程就会把锁从**仍在正常工作**的第一个进程
// 手里抢走, 两边并发写同一个 253MB 二进制——这正是本文件反复强调要杜绝的
// 数据损坏场景, 而且没有人工介入的余地。两害相权: pid 复用误判"仍持有"
// 只是烦人(报错文案已提示"确认没有其他实例在跑, 删掉锁文件即可"), 时间
// 兜底抢活锁是危险且不可逆的——所以不引入时间维度, pid 存活与否是唯一依据。
function lockIsStale(lock) {
  let pid = NaN;
  try { pid = parseInt(wfs.readFileSync(lock, 'utf8').trim(), 10); } catch { return true; }
  return !pidAlive(pid);
}

function acquireLock(target) {
  const lock = target + LOCK_SUFFIX;
  for (let i = 0; i < 3; i++) {
    try {
      const fd = wfs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return lock;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        // 拿不到锁绝不"照跑": 实测这条分支的真实触发场景恰恰是并发删除竞态,
        // 放行等于让多个进程同时改写同一个 253MB 二进制(审查实证)。
        throw new Error('无法创建锁文件(' + e.code + '): ' + lock + '\n  请检查目录权限后重试。');
      }
      if (!lockIsStale(lock)) {
        throw new Error('另一个 cchans 正在处理同一个 claude 二进制(锁文件: ' + lock + ')。\n' +
          '  请等它跑完再试; 若确认没有其他实例在跑, 删掉该锁文件即可。');
      }
      // 陈旧锁的接管必须原子: "先删再建"会让 A 删掉 B 刚建好的锁, 两个进程同时
      // 进入临界区(25 轮实测复现 1 次)。改用 rename —— 同目录 rename 是原子的,
      // 抢同一个陈旧锁时只有一个能成功。
      const claim = lock + '.taking.' + process.pid;
      try {
        wfs.renameSync(lock, claim);
        removeQuietly(claim, 2);
      } catch {
        sleepSync(100); // 没抢到接管权, 让赢家先建好锁, 下一轮会正确报 BUSY
      }
    }
  }
  throw new Error('反复尝试后仍无法获得锁: ' + lock + '\n  可能有其他 cchans 实例在竞争, 请稍后重试。');
}

function releaseLock(lock) {
  if (lock) removeQuietly(lock, 2);
}

// Ctrl+C / kill 时释放锁并清掉临时文件。patch 全程约 30~60 秒同步计算, 正是用户
// 最容易以为卡死而中断的时长 —— 没有这个处理器就会留下死锁 + 253MB 孤儿(审查实证)。
function installCleanupHandlers(lock, tmpRef) {
  const onSignal = sig => {
    releaseLock(lock);
    if (tmpRef.path) removeQuietly(tmpRef.path, 1);
    process.removeListener(sig, onSignal);
    process.kill(process.pid, sig);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const s of signals) { try { process.on(s, onSignal); } catch {} }
  return () => { for (const s of signals) { try { process.removeListener(s, onSignal); } catch {} } };
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
  try { mode = wfs.statSync(target).mode & 0o777; } catch {}
  // 只给"本来就有读权限"的身份补执行位, 不放宽可见范围:
  // 0700 -> 0700, 0644 -> 0755, 0755 -> 0755。
  // 直接 `mode | 0o111` 会把管理员刻意收紧的 0700 变成 0711, 让同机其他账号也能
  // 执行(Linux 上 --x 即可 execve), 违反管理员意图且 restore 修不回来。
  const wanted = mode | 0o100 | ((mode & 0o044) >> 2);
  try {
    wfs.chmodSync(tmp, wanted);
  } catch (e) {
    throw new Error('无法给补丁产物设置执行权限(' + e.code + '): ' + tmp +
      '\n  没有执行位的产物无法运行。请检查目录权限, 或改用有写权限的安装位置。');
  }
}

// 尽力删除临时文件: 刚写出的 253MB exe 常被杀毒软件即时扫描而短暂锁住,
// 一次 unlink 失败就放弃会留下 253MB 垃圾, 故重试几次。
function removeQuietly(p, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try { wfs.unlinkSync(p); return true; } catch (e) {
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
      wfs.renameSync(tmp, target);
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
    wfs.renameSync(target, aside);
  } catch (e) {
    removeQuietly(tmp);
    throw new Error(
      '目标文件被占用, 且无法为其改名让位(' + e.code + '): 请关闭所有正在运行的\n' +
      '  Claude Code(含后台会话, 可先跑 claude agents --json 查看), 再重新执行。\n' +
      '  你的 claude.exe 未被改动。'
    );
  }
  try {
    wfs.renameSync(tmp, target);
  } catch (e) {
    // 回滚必须如实上报: 若回滚也失败, 此刻磁盘上没有 claude.exe, 谎称"未被改动"
    // 会让唯一能自救的用户放弃自救。必须把 aside 的绝对路径交给用户。
    let rolledBack = true;
    try { wfs.renameSync(aside, target); } catch { rolledBack = false; }
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
  try { names = wfs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    // 精确匹配, 不能用 startsWith: 否则会删掉用户自己的
    // claude.exe.cchans-older-notes.txt 之类同前缀文件(审查实证)。
    if (n === prefix || n.startsWith(prefix + '.')) removeQuietly(path.join(dir, n), 1);
  }
}

// 自愈实现放在 locate.js(见那里的注释: CLI 先 locate 再进 patcher, 放这里是死代码),
// 此处仅复用, 保证两条入口行为一致。
const healInterrupted = healMissing;

function atomicWrite(target, buf) {
  const tmp = tmpPathFor(target);
  try {
    wfs.writeFileSync(tmp, buf);
    inheritExecMode(tmp, target);
  } catch (e) {
    removeQuietly(tmp);
    throw e;
  }
  return commitTmp(tmp, target);
}

// 回收本目录下所有 cchans 临时文件/探针。
// 必须枚举目录: 只删"自己 pid 的名字"会让**别的进程**中断时留下的 253MB 孤儿
// 永远无人回收(每中断一次泄漏一份, 审查实证)。带 pid 的只在该进程已死时才删,
// 避免误删另一个正在运行的实例的工作文件。
function cleanTmp(target) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  let names = [];
  try { names = wfs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    let suffix = null;
    for (const p of ['.cchans-tmp', '.cchans-probe']) {
      if (n === base + p) { suffix = ''; break; }
      if (n.startsWith(base + p + '.')) { suffix = n.slice((base + p + '.').length); break; }
    }
    if (suffix === null) continue;
    if (suffix !== '') {
      const pid = parseInt(suffix, 10);
      if (Number.isInteger(pid) && pid !== process.pid && pidAlive(pid)) continue; // 别人还在用
    }
    removeQuietly(path.join(dir, n), 1);
  }
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

// 乱码检测 —— 补上"只验能跑、不验显示对不对"的缺口(2026-08-03 事故: 补丁"验证通过"
// 却一个正确中文都没有, 全是 Latin-1 炸开的乱码, 直到用户打开菜单才发现)。
// 特征: UTF-8 解出一串 U+0080–U+00FF 的字符, 把它们按 Latin-1 转回字节后又能解出 CJK。
// 纯英文输出不会命中; 正确渲染的中文也不会命中(它直接就解成 CJK)。
const CJK_RE = /[一-鿿]/;

function findMojibake(text) {
  const re = /[-ÿ]{3,}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const decoded = Buffer.from(m[0], 'latin1').toString('utf8');
    if (!decoded.includes('�') && CJK_RE.test(decoded)) {
      return { garbled: m[0].slice(0, 20), meant: decoded.slice(0, 10) };
    }
  }
  return null;
}
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
  // Windows 上 CreateProcess 卡 MAX_PATH(260): 路径一长 spawn 就 ENOENT, 会被
  // 误判成"补丁产物跑不起来"。复用 toLongPath 加 \\?\ 前缀绕过(此前这里是一份
  // 单独手写的等价逻辑, 只在 win32 & 长度>200 & 盘符绝对路径时才加前缀; 统一
  // 成 toLongPath 后短路径也会加前缀——两者对 CreateProcess 都合法, 实测
  // 274 字符路径和现实生产短路径均正常, 不引入行为差异)。
  const spawnPath = toLongPath(exePath);
  try {
    let cjkSeen = 0;
    for (const args of SMOKE_ARGS) {
      const label = args.join(' ');
      const r = spawnSync(spawnPath, args, {
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
      const moji = findMojibake(out);
      if (moji) {
        return { ok: false, kind: 'mojibake',
          reason: label + ' 输出含乱码: ' + JSON.stringify(moji.garbled) + ' (本应是 ' + moji.meant + '…)' };
      }
      cjkSeen += (out.match(/[一-鿿]/g) || []).length;
    }
    // 跑通了、也没乱码, 但一个中文都没有 => 补丁其实没生效, 同样不算成功。
    if (cjkSeen === 0) {
      return { ok: false, kind: 'noeffect', reason: '产物能跑但输出里没有任何中文 —— 补丁未生效' };
    }
    return { ok: true, cjkSeen };
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

// 开扫之前先探一次写权限: 扫描+验证要 30~60 秒, 若目标目录不可写(Linux/macOS 上
// npm 全局目录常归 root), 让用户白等一分半再吐一条裸 EACCES 是很糟的体验 ——
// 这也是非 Windows 平台最常见的失败模式(审查实证)。
function assertWritable(target) {
  const probe = target + '.cchans-probe.' + process.pid;
  try {
    wfs.writeFileSync(probe, 'x');
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      throw new Error('没有写权限: ' + path.dirname(target) + ' (' + e.code + ')\n' +
        (process.platform === 'win32'
          ? '  请用管理员权限运行, 或把 Claude Code 装到有写权限的位置。'
          : '  请用 sudo 运行, 或把 Claude Code 装到有写权限的位置(如 ~/.local)。'));
    }
    throw e;
  }
  removeQuietly(probe, 2);
}

// 所有会改写 target 的操作的统一入口: 校验 → 探写权限 → 加锁 → 装信号处理器。
// restore 也必须走这里 —— 实测 patch 与 restore 并发会丢失更新(两条命令都打印 ✓,
// 而用户的 restore 被后完成的 patch 静默覆盖), 且 restore 的 cleanAside 可能删掉
// patch 回滚所需的让位副本(审查实证)。
function withTargetLock(target, fn) {
  assertWritable(target);
  const lock = acquireLock(target);
  const tmpRef = { path: null };
  const uninstall = installCleanupHandlers(lock, tmpRef);
  try {
    return fn(tmpRef);
  } finally {
    uninstall();
    releaseLock(lock);
  }
}

function patch(target, opts = {}) {
  const healed = healInterrupted(target); // 必须在 isClaudeBinary 之前
  if (!isClaudeBinary(target)) {
    throw new Error('不是有效的 Claude Code 二进制(缺少 Bun 魔术串或体积过小): ' + target);
  }
  return withTargetLock(target, tmpRef => patchLocked(target, opts, healed, tmpRef));
}

function patchLocked(target, opts, healed, tmpRef) {
  const dict = loadDict();
  cleanTmp(target); // 回收上次写盘失败留下的半成品
  // 注意顺序: cleanAside 必须在 resolveSource **之后**。让位副本可能是用户手上
  // 最后一份纯英文原版(例如备份被误删), 先删再发现没有可用源就无法挽回了
  // (2026-08-03 审查实证)。
  const { source, refreshed, backupPath: srcBackup } = resolveSource(target);
  // 必须先能定位主模块: 替换只在它的 JS 源码区内做, 且要关掉字节码、把源码编码
  // 改成 UTF-8。定位不到就不能打 —— 盲目全局替换正是 2026-08-03 那次"全是乱码"
  // 事故的根因(详见 DEVELOPMENT-NOTES §十三)。
  const mainMod = bunfmt.findMainModule(source);
  if (!mainMod) {
    throw new Error('无法解析 Bun 模块结构, 已中止(你的 claude 未被改动)。\n' +
      '  这通常意味着 Claude Code 换了打包格式, 本工具需要适配。\n' +
      '  请到 GitHub 提 issue: ForceMind/Claude-Code-Chinese-Simplified');
  }
  // 两道安全网必须至少有一道生效: 要么实跑验证兜底, 要么源已被 sha256 锚校验过。
  // 都缺席时, 一份"体积和尾串都完好、中段损坏"的备份会产出跑不起来的二进制并
  // 直接落地(第三轮实证的唯一不可恢复路径)。
  if (opts.verify === false && !wfs.existsSync(srcBackup + SHA_SUFFIX)) {
    throw new Error('拒绝在"跳过验证"且"备份无完整性锚"的情况下打补丁 —— 两道安全网\n' +
      '  同时缺席时, 中段损坏的备份会产出跑不起来的 claude 并直接覆盖你现在能用的那个。\n' +
      '  请先跑一次不带 --no-verify 的 patch(会自动补上锚), 之后再用 --no-verify。');
  }
  cleanAside(target); // 已确认拿到可用的纯英文源, 此时回收陈旧让位副本才安全
  const buf = Buffer.from(source); // 副本, 不动源
  const t0 = Date.now();

  // 1) 关掉 JSC 预编译字节码, 让 Bun 回退去解析 JS 源码。
  //    不关的话: 字节码优先, 对源码的替换根本不生效; 而直接改字节码里的字符串
  //    又必然乱码(那里是 8-bit 存储)。这 4 个字节是等长写入。
  if (mainMod.bytecodeLength > 0) buf.writeUInt32LE(0, mainMod.bytecodeLengthAt);
  // 2) 源码编码改成 UTF-8, 否则中文会被逐字节当成 Latin-1 字符。1 个字节, 等长。
  if (mainMod.encoding !== bunfmt.JS_SOURCE_ENCODING_UTF8) {
    buf.writeUInt8(bunfmt.JS_SOURCE_ENCODING_UTF8, mainMod.encodingAt);
  }
  // 3) 只在主模块的 JS 源码区内做等长替换, 绝不碰字节码区与原生数据区。
  const region = buf.subarray(mainMod.sourceStart, mainMod.sourceEnd);
  let stats;
  if (opts.full) {
    // 实验特性 --full: 全局长度预算重写, 可容纳超长译文(详见 rewriteRegion 注释)
    const rw = rewriteRegion(region, dict, loadOversize(), opts.onProgress);
    rw.buf.copy(region); // 等长, 原位覆盖
    stats = rw.stats;
  } else {
    stats = patchBuffer(region, dict, opts.onProgress, { segs: stringSegments(region) });
  }
  stats.bytecodeDisabled = mainMod.bytecodeLength > 0;
  stats.sourceBytes = mainMod.sourceEnd - mainMod.sourceStart;

  if (buf.length !== source.length) {
    throw new Error('内部错误: 补丁改变了文件长度(' + source.length + ' -> ' + buf.length + '), 已中止写入。');
  }
  if (stats.keysHit === 0) {
    throw new Error('没有任何词条命中 —— 词典可能与该版本完全不匹配, 已中止写入。请运行 scan 诊断。');
  }
  // 先落临时文件 → (macOS 重签名) → 实跑验证 → 通过才 rename 覆盖 target。
  // 验证不通过时 target 保持原样, 用户环境不受任何影响。
  const tmp = tmpPathFor(target);
  let resigned = null;
  let verified = null;
  try {
    wfs.writeFileSync(tmp, buf); // 必须在 try 内: 磁盘满时才不会留下 253MB 残骸
    if (tmpRef) tmpRef.path = tmp; // 交给信号处理器, Ctrl+C 时能清掉这 253MB
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
          : v.kind === 'mojibake'
          ? '  中文被逐字节当成了 Latin-1 字符 —— 说明替换落到了按单字节存储的区域\n' +
            '  (通常是 JSC 字节码), 或源码编码字段没被正确改成 UTF-8。这是本工具的\n' +
            '  bug, 请到 GitHub 提 issue 并附上本条信息。'
          : v.kind === 'noeffect'
          ? '  补丁没有实际生效 —— 可能是 Claude Code 换了打包方式(例如源码不再被解析)。\n' +
            '  请到 GitHub 提 issue 并附上你的 Claude Code 版本号。'
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
  // 锚补写: 存量用户的备份是老版本工具建的, 没有锚。此刻刚实证"这份源能产出跑得
  // 起来的二进制", 是补锚最有说服力的时刻 —— 否则他们永远拿不到这层保护(实测: 走
  // 汉化分支时 cand === backupPath, 老代码整个跳过 writeBackup, 锚永不创建)。
  if (verified && !wfs.existsSync(srcBackup + SHA_SUFFIX)) {
    try { wfs.writeFileSync(srcBackup + SHA_SUFFIX, sha256(source)); } catch {}
  }
  const commit = commitTmp(tmp, target);
  return {
    healed,                        // true=自愈了上次中断留下的缺失 target
    movedAside: commit.movedAside, // true=旧映像仍在运行, 暂留 .cchans-old.<时间戳>
    keysHit: stats.keysHit,
    occurrences: stats.occurrences,
    boundarySkips: stats.boundarySkips,
    poolSkips: stats.poolSkips,
    codeSkips: stats.codeSkips || 0,
    cmpSkips: stats.cmpSkips || 0,
    overEntries: stats.overEntries,
    overOccurrences: stats.overOccurrences,
    overDropped: stats.overDropped,
    slack: stats.slack,
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
  return withTargetLock(target, () => {
    const backupPath = target + BACKUP_SUFFIX;
    if (!wfs.existsSync(backupPath)) {
      throw new Error('找不到备份: ' + backupPath);
    }
    if (!isClaudeBinary(backupPath)) {
      throw new Error('备份文件不是完整的 Claude Code 二进制(可能上次写盘中断被截断), 拒绝还原: ' + backupPath);
    }
    const buf = wfs.readFileSync(backupPath);
    if (!backupIntact(backupPath, buf)) {
      throw new Error('备份文件校验失败(sha256 与记录不符, 内容已损坏), 拒绝还原: ' + backupPath +
        '\n  若确信备份没问题, 可删掉锚文件 ' + backupPath + SHA_SUFFIX + ' 后重试;\n' +
        '  否则请重装 Claude Code: npm install -g @anthropic-ai/claude-code');
    }
    if (looksTranslated(buf)) {
      throw new Error('备份文件本身已被汉化, 拒绝还原(会覆盖不掉中文)。请重装 Claude Code。');
    }
    cleanTmp(target);
    cleanAside(target);
    const commit = atomicWrite(target, buf);
    return { restoredFrom: backupPath, healed, movedAside: commit.movedAside };
  });
}

function status(target) {
  const backupPath = target + BACKUP_SUFFIX;
  const buf = wfs.readFileSync(target);
  return {
    target,
    version: readVersion(target),
    size: buf.length,
    translated: looksTranslated(buf),
    hasBackup: wfs.existsSync(backupPath),
    hasZhCnBackup: wfs.existsSync(target + ZHCN_BACKUP_SUFFIX),
  };
}

module.exports = {
  loadDict, looksTranslated, countCjkRuns, resolveSource,
  patchBuffer, rewriteRegion, loadOversize, stringSegments, insideString,
  atomicWrite, patch, restore, status, resignIfDarwin,
  verifyRuntime, cleanAside, cleanTmp, backupIntact, inNativePool,
  acquireLock, releaseLock, pidAlive, withTargetLock, lockIsStale,
  BACKUP_SUFFIX, DICT_PATH,
};
