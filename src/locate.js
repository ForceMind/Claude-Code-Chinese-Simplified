'use strict';
// 定位 Claude Code 原生二进制(Bun 编译单文件, Windows 上 ~226MB 的 claude.exe)。
// 校验依据: 文件尾部含 Bun 单文件魔术串, 且体积 > 20MB(排除 shim/脚本)。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'claude.exe' : 'claude';
const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
const PKG_REL = path.join('node_modules', '@anthropic-ai', 'claude-code', 'bin', BIN_NAME);

function isClaudeBinary(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 20 * 1024 * 1024) return false;
    const fd = fs.openSync(p, 'r');
    try {
      const tailLen = Math.min(65536, st.size);
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, st.size - tailLen);
      return tail.includes(BUN_TRAILER);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// bin/claude.exe 的上级目录通常就是 @anthropic-ai/claude-code 包根;
// 原生安装器(claude install)没有 package.json, 但版本号在路径里
// (~/.local/share/claude/versions/<版本>/...), 从路径段兜底解析。
function readVersion(binPath) {
  try {
    const pkg = path.resolve(path.dirname(binPath), '..', 'package.json');
    const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    if (j && j.name === '@anthropic-ai/claude-code') return j.version || null;
  } catch {}
  const m = binPath.match(/[\\/](\d+\.\d+\.\d+(?:-[\w.]+)?)[\\/]/);
  return m ? m[1] : null;
}

// `where/which claude` 命中的往往是 npm shim(几 KB 的 .cmd/sh),
// 真身在同目录的 node_modules/@anthropic-ai/claude-code/bin/ 下
function candidatesFromShim(shimPath) {
  const dir = path.dirname(shimPath);
  return [shimPath, path.join(dir, PKG_REL)];
}

function whichClaude() {
  const cmd = IS_WIN ? 'where claude' : 'which claude';
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function commonLocations() {
  const home = os.homedir();
  const list = [];
  // 原生安装器(claude install / install.sh)统一放 ~/.local/bin, 三平台通用
  list.push(path.join(home, '.local', 'bin', BIN_NAME));
  if (IS_WIN) {
    if (process.env.APPDATA) list.push(path.join(process.env.APPDATA, 'npm', PKG_REL));
    list.push(path.join('C:', 'nvm4w', 'nodejs', PKG_REL));
    if (process.env.ProgramFiles) list.push(path.join(process.env.ProgramFiles, 'nodejs', PKG_REL));
  } else {
    list.push(path.join('/opt/homebrew/bin', BIN_NAME)); // macOS Apple Silicon Homebrew
    list.push(path.join('/usr/local/bin', BIN_NAME));
    list.push(path.join('/usr/local/lib', PKG_REL));
    list.push(path.join(home, '.local', 'lib', PKG_REL));
    list.push(path.join(home, '.npm-global', PKG_REL));
    list.push(path.join(home, '.bun', 'bin', BIN_NAME));
  }
  list.push(path.join(home, '.claude', 'local', PKG_REL));
  return list;
}

const ASIDE_SUFFIX = '.cchans-old';

// 上次热替换若在「已让位、新文件尚未就位」的窗口里被中断, target 会缺失, 而同目录
// 躺着完好的让位副本。此处在校验二进制之前先自愈 —— 必须放在 locate 里而不是只放在
// patcher 里: CLI 是先 locate 再进 patcher 的, 放在 patcher 里等于死代码
// (2026-08-03 审查实证)。纯 fs 操作, 不依赖 patcher, 不引入循环依赖。
function healMissing(target) {
  try {
    if (fs.existsSync(target)) return false;
    const dir = path.dirname(target);
    const prefix = path.basename(target) + ASIDE_SUFFIX;
    // 必须精确匹配 `<basename>.cchans-old` 或 `<basename>.cchans-old.<时间戳>`。
    // 用 startsWith 会把用户自己的 claude.exe.cchans-older-notes.txt 也算进来 ——
    // 这里是 rename 到 target, 等于把用户文件冒名顶替成 claude.exe(审查实证)。
    const names = fs.readdirSync(dir).filter(n => n === prefix || n.startsWith(prefix + '.'));
    if (!names.length) return false;
    // 按 mtime 取最新(比依赖文件名里的时间戳字符串排序更稳)
    const ranked = names.map(n => {
      const p = path.join(dir, n);
      let t = 0;
      try { t = fs.statSync(p).mtimeMs; } catch {}
      return { p, t };
    }).sort((a, b) => b.t - a.t);
    for (const { p } of ranked) {
      if (!isClaudeBinary(p)) continue;
      try { fs.renameSync(p, target); return true; } catch {}
    }
  } catch {}
  return false;
}

// 返回 { path, version, healed } 或 null。
// 显式路径(参数 / CCHANS_TARGET)是**权威**的: 校验不过直接失败, 绝不悄悄改打别的
// 安装位置 —— 否则用户敲错路径就会误伤另一个 claude.exe(2026-08-03 审查实证)。
// 只有在完全没有显式指定时, 才按 PATH > 常见全局位置自动探测。
// 是否存在可用于自愈的让位副本(只探测, 不动手)
function healable(target) {
  try {
    if (fs.existsSync(target)) return null;
    const dir = path.dirname(target);
    const prefix = path.basename(target) + ASIDE_SUFFIX;
    const names = fs.readdirSync(dir).filter(n => n === prefix || n.startsWith(prefix + '.'));
    const ok = names.map(n => path.join(dir, n)).filter(isClaudeBinary);
    return ok.length ? ok : null;
  } catch { return null; }
}

// opts.heal: 是否允许改文件系统。只有 patch/restore 传 true —— status/scan/locate
// 是只读语义的命令, 让它们 rename 文件会违反用户预期(而且自动探测分支会对**每个**
// 候选位置各自愈一次, 可能把用户早已卸载的安装位置"复活", 审查实证)。
function locate(explicit, opts = {}) {
  const heal = opts.heal === true;
  const pinned = explicit || process.env.CCHANS_TARGET || null;
  if (pinned) {
    const healed = heal ? healMissing(pinned) : false;
    if (!isClaudeBinary(pinned)) {
      return null;
    }
    let real = pinned;
    try { real = fs.realpathSync(pinned); } catch {}
    return { path: real, version: readVersion(real), healed, healable: healable(pinned) };
  }

  const tried = [];
  for (const shim of whichClaude()) tried.push(...candidatesFromShim(shim));
  tried.push(...commonLocations());

  for (const p of tried) {
    // healed 必须绑定到最终返回的那个候选, 否则 status 可能打印"已自愈"
    // 而说的根本不是它随后报告的那个 target(审查实证)。
    const healed = heal ? healMissing(p) : false;
    if (isClaudeBinary(p)) {
      // 原生安装的 claude 常是符号链接(指向 versions/<版本>/ 下的真身),
      // 解析成真实路径再补丁, 避免 rename 只替换了链接本身
      let real = p;
      try { real = fs.realpathSync(p); } catch {}
      return { path: real, version: readVersion(real), healed };
    }
  }
  return null;
}

module.exports = {
  locate, isClaudeBinary, readVersion, healMissing, healable,
  BUN_TRAILER, BIN_NAME, ASIDE_SUFFIX,
};
