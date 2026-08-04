'use strict';
// Windows 传统 MAX_PATH(260 字符)绕过: 给绝对路径加 \\?\ 前缀直接走 Win32
// 的"扩展长度路径"语义, 跳过 MAX_PATH 校验。深层 nvm-windows/node_modules
// 安装路径很容易越过这个门槛(2026-08-04 审查发现: 本仓库此前只有
// verifyRuntime 一处打了这个补丁, 其余 fs 调用全程裸奔, 越界路径下会直接
// ENOENT, 且报错文案完全不提示真实原因)。
//
// \\?\ 语义要求: 必须是已解析的绝对路径、反斜杠分隔、不含 . 或 .. 段——
// path.resolve() 已经满足这三点, 直接调用即可, 不需要额外规范化。
const path = require('path');

function toLongPath(p) {
  if (process.platform !== 'win32' || typeof p !== 'string' || p.length === 0) return p;
  const resolved = path.resolve(p).replace(/\//g, '\\');
  if (resolved.startsWith('\\\\?\\')) return resolved; // 已经是扩展路径, 不重复加
  if (resolved.startsWith('\\\\')) return '\\\\?\\UNC\\' + resolved.slice(2); // UNC 网络路径专用形式
  return '\\\\?\\' + resolved;
}

module.exports = { toLongPath };
