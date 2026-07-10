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
const path = require('path');
const { execFileSync } = require('child_process');
const { isClaudeBinary, readVersion } = require('./locate');

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

  // target 已汉化 → 必须有纯英文备份作源
  if (fs.existsSync(backupPath)) {
    const b = fs.readFileSync(backupPath);
    if (!looksTranslated(b)) return { source: b, backupPath, refreshed: false };
    throw new Error('备份文件 ' + backupPath + ' 本身已被汉化, 不能作源。请重装/升级 Claude Code 后重试。');
  }
  const zhcnPath = target + ZHCN_BACKUP_SUFFIX;
  if (fs.existsSync(zhcnPath)) {
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

function patchBuffer(buf, dict, onProgress) {
  const keys = Object.keys(dict);
  let keysHit = 0, occurrences = 0, boundarySkips = 0;
  for (let k = 0; k < keys.length; k++) {
    const en = keys[k];
    const enBuf = Buffer.from(en, 'utf8');
    const zhBuf = Buffer.from(dict[en], 'utf8');
    if (zhBuf.length > enBuf.length) continue; // 词典保证不会, 双保险
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
      zhBuf.copy(buf, idx);
      buf.fill(0x20, idx + zhBuf.length, idx + enBuf.length); // 空格填充到原长
      hits++;
      from = idx + enBuf.length;
    }
    if (hits) { keysHit++; occurrences += hits; }
    if (onProgress && (k + 1) % 50 === 0) onProgress(k + 1, keys.length, keysHit);
  }
  return { keysHit, occurrences, boundarySkips };
}

// 同目录写临时文件再 rename(同盘保证原子性); rename 覆盖会让 target 指向新
// inode, 与 install 时的硬链接副本自然隔离。Windows 上目标被运行中的进程占用
// 时 rename 抛 EBUSY/EPERM, 转成友好提示。
function atomicWrite(target, buf) {
  const tmp = target + '.cchans-tmp';
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') {
      throw new Error('目标文件被占用: 请先关闭所有正在运行的 Claude Code, 再重新执行。');
    }
    throw e;
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
  if (!isClaudeBinary(target)) {
    throw new Error('不是有效的 Claude Code 二进制(缺少 Bun 魔术串或体积过小): ' + target);
  }
  const dict = loadDict();
  const { source, refreshed } = resolveSource(target);
  const buf = Buffer.from(source); // 副本, 不动源
  const t0 = Date.now();
  const stats = patchBuffer(buf, dict, opts.onProgress);
  if (buf.length !== source.length) {
    throw new Error('内部错误: 补丁改变了文件长度(' + source.length + ' -> ' + buf.length + '), 已中止写入。');
  }
  if (stats.keysHit === 0) {
    throw new Error('没有任何词条命中 —— 词典可能与该版本完全不匹配, 已中止写入。请运行 scan 诊断。');
  }
  atomicWrite(target, buf);
  return {
    keysHit: stats.keysHit,
    occurrences: stats.occurrences,
    boundarySkips: stats.boundarySkips,
    dictTotal: Object.keys(dict).length,
    backupRefreshed: refreshed,
    seconds: (Date.now() - t0) / 1000,
    version: readVersion(target),
    resigned: resignIfDarwin(target), // null=非 macOS, true=已重签名, false=重签名失败
  };
}

function restore(target) {
  const backupPath = target + BACKUP_SUFFIX;
  if (!fs.existsSync(backupPath)) {
    throw new Error('找不到备份: ' + backupPath);
  }
  const buf = fs.readFileSync(backupPath);
  if (looksTranslated(buf)) {
    throw new Error('备份文件本身已被汉化, 拒绝还原(会覆盖不掉中文)。请重装 Claude Code。');
  }
  atomicWrite(target, buf);
  return { restoredFrom: backupPath };
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
  BACKUP_SUFFIX, DICT_PATH,
};
