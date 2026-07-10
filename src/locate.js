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

// 返回 { path, version } 或 null。优先级: 显式参数 > CCHANS_TARGET 环境变量 > PATH > 常见全局位置
function locate(explicit) {
  const tried = [];
  if (explicit) tried.push(explicit);
  if (process.env.CCHANS_TARGET) tried.push(process.env.CCHANS_TARGET);
  for (const shim of whichClaude()) tried.push(...candidatesFromShim(shim));
  tried.push(...commonLocations());

  for (const p of tried) {
    if (isClaudeBinary(p)) {
      // 原生安装的 claude 常是符号链接(指向 versions/<版本>/ 下的真身),
      // 解析成真实路径再补丁, 避免 rename 只替换了链接本身
      let real = p;
      try { real = fs.realpathSync(p); } catch {}
      return { path: real, version: readVersion(real) };
    }
  }
  return null;
}

module.exports = { locate, isClaudeBinary, readVersion, BUN_TRAILER, BIN_NAME };
