'use strict';
// Bun 单文件二进制的最小结构解析 —— 零依赖, 且**不解析 PE/Mach-O/ELF**。
//
// 为什么需要它(2026-08-03 血的教训, 详见 DEVELOPMENT-NOTES §十三):
// 早先的做法是在整个 253MB 文件上全局搜索英文串就地替换。实测发现 Claude Code
// 2.1.220 的主模块带 **146.7MB 的 JSC 预编译字节码**, 而字节码里的字符串常量是
// 按 8-bit(Latin-1) 存的 —— 往里写 UTF-8 中文会被逐字节炸开成乱码
// (「自动更新频道」显示为「èªå¨æ´æ°é¢é 」)。同时, 有字节码在时 Bun 走的是字节码,
// 对 JS 源码区的替换根本不生效。两者叠加的结果是: 补丁看起来"成功"了, 实际上
// 一个正确的中文都没有。
//
// 出路: 模块表里有两个**等长可改**的字段 ——
//   1) bytecode 的 length 置 0  -> Bun 找不到字节码, 回退去解析 JS 源码;
//   2) encoding 字节置 0(UTF-8) -> 源码按 UTF-8 解码, 中文才不会被当成单字节。
// 再把替换严格限制在该模块的 JS 源码区内。实测: 973 个中文正确渲染, 零乱码。
//
// 定位方式: blob 尾部是 [32 字节 Offsets][16 字节 trailer], 而 Offsets 的首字段
// byteCount = blobLen - 48(不含 Offsets 与 trailer 自身)。于是从文件里最后一个
// trailer 反推即可拿到 blob 基址, 全程纯 Buffer 算术, 与可执行文件格式无关。

const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
const SIZEOF_OFFSETS = 32;
const SIZEOF_STRING_POINTER = 8;
const SIZEOF_MODULE_OLD = 4 * SIZEOF_STRING_POINTER + 4;  // 36
const SIZEOF_MODULE_NEW = 6 * SIZEOF_STRING_POINTER + 4;  // 52
const JS_SOURCE_ENCODING_UTF8 = 0;

const readPtr = (buf, off) => ({
  offset: buf.readUInt32LE(off),
  length: buf.readUInt32LE(off + 4),
});

function isClaudeModuleName(name) {
  return name.endsWith('/claude') || name === 'claude' ||
    name.endsWith('/src/entrypoints/cli.js') || name === 'src/entrypoints/cli.js';
}

// 从整个文件 buffer 里解析出 Bun blob 与模块表。失败返回 null(调用方自行降级)。
function parse(buf) {
  // 取**最后**一个 trailer: 二进制里可能有别的地方出现同样的字面串
  let trailerAt = -1, from = 0, i;
  while ((i = buf.indexOf(BUN_TRAILER, from)) !== -1) { trailerAt = i; from = i + 1; }
  if (trailerAt < SIZEOF_OFFSETS) return null;

  const offsetsAt = trailerAt - SIZEOF_OFFSETS;
  const byteCount = Number(buf.readBigUInt64LE(offsetsAt));
  if (!Number.isSafeInteger(byteCount) || byteCount <= 0) return null;

  const blobEnd = trailerAt + BUN_TRAILER.length;
  const blobBase = blobEnd - (byteCount + SIZEOF_OFFSETS + BUN_TRAILER.length);
  if (blobBase < 0 || blobBase >= trailerAt) return null;

  const modulesPtr = readPtr(buf, offsetsAt + 8);
  const structSize =
    (modulesPtr.length % SIZEOF_MODULE_NEW === 0 && modulesPtr.length % SIZEOF_MODULE_OLD !== 0) ? SIZEOF_MODULE_NEW :
    (modulesPtr.length % SIZEOF_MODULE_OLD === 0 && modulesPtr.length % SIZEOF_MODULE_NEW !== 0) ? SIZEOF_MODULE_OLD :
    SIZEOF_MODULE_NEW;
  const count = modulesPtr.length / structSize;
  if (!Number.isInteger(count) || count <= 0 || count > 4096) return null;

  const modules = [];
  for (let k = 0; k < count; k++) {
    const rec = blobBase + modulesPtr.offset + k * structSize;
    if (rec + structSize > buf.length) return null;
    let p = rec;
    const name = readPtr(buf, p); p += SIZEOF_STRING_POINTER;
    const contents = readPtr(buf, p); p += SIZEOF_STRING_POINTER;
    p += SIZEOF_STRING_POINTER;                                  // sourcemap
    const bytecodeAt = p;
    const bytecode = readPtr(buf, p); p += SIZEOF_STRING_POINTER;
    if (structSize === SIZEOF_MODULE_NEW) p += SIZEOF_STRING_POINTER * 2;
    const encodingAt = p;

    const nameStart = blobBase + name.offset;
    if (nameStart + name.length > buf.length) return null;
    modules.push({
      name: buf.slice(nameStart, nameStart + name.length).toString('utf8'),
      // 源码在**文件**中的绝对区间
      sourceStart: blobBase + contents.offset,
      sourceEnd: blobBase + contents.offset + contents.length,
      bytecodeLength: bytecode.length,
      encoding: buf.readUInt8(encodingAt),
      // 这两个字段自身的文件偏移 —— 改它们是等长原地写入
      bytecodeLengthAt: bytecodeAt + 4,
      encodingAt,
    });
  }
  return { blobBase, modules };
}

// 找出承载 Claude Code 自身 JS 的主模块
function findMainModule(buf) {
  const parsed = parse(buf);
  if (!parsed) return null;
  const m = parsed.modules.find(x => isClaudeModuleName(x.name));
  if (!m) return null;
  if (m.sourceEnd <= m.sourceStart || m.sourceEnd > buf.length) return null;
  return m;
}

module.exports = {
  parse, findMainModule, isClaudeModuleName,
  BUN_TRAILER, JS_SOURCE_ENCODING_UTF8,
};
