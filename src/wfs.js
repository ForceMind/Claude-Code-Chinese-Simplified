'use strict';
// fs 的长路径安全子集: 只包着本项目实际用到的、以路径字符串为参数的同步
// API, 调用前统一过一遍 toLongPath()。fd 参数的 API(readSync/writeSync/
// closeSync)不涉及路径, 直接用原生 fs 即可, 不必包在这里。
const fs = require('fs');
const { toLongPath } = require('./winpath');

function wrap1(fn) {
  return (p, ...rest) => fn(toLongPath(p), ...rest);
}
function wrap2(fn) {
  return (a, b, ...rest) => fn(toLongPath(a), toLongPath(b), ...rest);
}

module.exports = {
  statSync: wrap1(fs.statSync),
  existsSync: wrap1(fs.existsSync),
  readFileSync: wrap1(fs.readFileSync),
  writeFileSync: wrap1(fs.writeFileSync),
  openSync: wrap1(fs.openSync),
  unlinkSync: wrap1(fs.unlinkSync),
  readdirSync: wrap1(fs.readdirSync),
  // 注意: 普通 fs.realpathSync 是 Node 自己手写的逐段 lstat walk, 遇 \\?\ 前缀会在
  // 盘符根上炸出 EISDIR(2026-08-04 实测复现, 与路径长短无关, 纯粹是该实现不认识
  // 这个前缀)。.native 直接调用系统调用, 认得 \\?\ 且返回值本身就是不带前缀的
  // 干净路径, 两者都要用它, 不能像其余函数一样简单套 wrap1。
  realpathSync: wrap1(fs.realpathSync.native),
  chmodSync: wrap1(fs.chmodSync),
  renameSync: wrap2(fs.renameSync),
};
