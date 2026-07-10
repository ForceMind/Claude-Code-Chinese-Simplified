#!/usr/bin/env node
'use strict';
// 从上游文本词典(dict/sources/cli-translations.json, [{en,zh}])构建
// 「等长安全」词典 dict/zh-Hans.json —— 只保留中文 UTF-8 字节数 <= 英文字节数的条目,
// 这样补丁时可原地替换(中文 + 空格填充), 保持二进制字节长度不变、无需重打包。
//
// 可持续: 上游词典更新后, 重新跑 `node tools/build-dict.cjs` 即可增量重建。
// 超长条目(中文比英文长)会被统计并跳过, 等待未来「重打包引擎」或人工缩写。
//
// 重要实证(2026-07, 详见 DEVELOPMENT-NOTES.md):
// - 二进制内嵌的是 JS 源码文本, 词典 en 里的字面 \uXXXX 转义(如 —)在二进制中
//   就是这 6 个 ASCII 字符, 保持原样即可命中 —— 不要反解成真实 UTF-8(反解后打不中)。
// - en 含 ${...} 的条目是抽取态占位符(有的还带混淆后的版本特定标识符), 原始字节
//   匹配永远打不中, 且版本锁死, 必须剔除。
// - 命中的都是 JS 字符串字面量内部, 所以 zh 中出现而 en 中没有的引号类字符
//   (" ' ` \ 换行)可能破坏字面量语法, 剔除; en 里也有同款字符则说明该字面量
//   本就容纳它, 安全保留。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'dict', 'sources', 'cli-translations.json');
const OUT = path.join(ROOT, 'dict', 'zh-Hans.json');
const OVER = path.join(ROOT, 'dict', 'oversize.json');

const byteLen = s => Buffer.byteLength(s, 'utf8');
const hasHan = s => /[㐀-鿿＀-￯　-〿]/.test(s);
const asciiPrintable = s => /^[\x20-\x7e]+$/.test(s);

// 裸标识符词(如 "Sandbox"、"Cancelled"): 实证发现它们大量出现在压缩代码的
// 标识符/属性名位置, 即使 patcher 有词边界守卫, 独立属性名 {Sandbox:1} 被
// 替换后仍会与被填充的字符串键 "沙盒 " 不一致 → 语义损坏。整词剔除。
const bareIdentWord = en => /^[A-Za-z][A-Za-z0-9_$]*$/.test(en);

// zh 引入了 en 没有的字面量危险字符 → 可能破坏 JS 字符串语法
const zhUnsafe = (en, zh) => {
  if (/[\r\n]/.test(zh)) return true;
  for (const ch of ['"', "'", '`', '\\']) {
    if (zh.includes(ch) && !en.includes(ch)) return true;
  }
  if (zh.includes('${') && !en.includes('${')) return true;
  return false;
};

if (!fs.existsSync(SRC)) {
  console.error('缺少上游词典: ' + SRC);
  console.error('请先复制 claude-code-zh-cn 的 cli-translations.json 到该路径。');
  process.exit(1);
}

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const safe = {};
const oversize = {};
let total = 0, kept = 0, over = 0, skipped = 0, placeholder = 0, unsafe = 0, tooShort = 0, bareWord = 0;

for (const item of src) {
  total++;
  const en = item && item.en, zh = item && item.zh;
  if (!en || !zh || en === zh) { skipped++; continue; }
  if (!asciiPrintable(en)) { skipped++; continue; }   // en 必须是可打印 ASCII 才能在二进制里定位
  if (!hasHan(zh)) { skipped++; continue; }            // zh 必须含中文, 否则不是有效翻译
  if (en.includes('${')) { placeholder++; continue; }  // 抽取态占位符, 永远打不中且版本锁死
  if (zhUnsafe(en, zh)) { unsafe++; continue; }        // zh 会破坏字符串字面量语法
  if (bareIdentWord(en)) { bareWord++; continue; }     // 裸标识符词, 语义损坏风险
  if (byteLen(en) < 6) { tooShort++; continue; }       // 过短的 en 误伤风险高(B4)
  if (byteLen(zh) > byteLen(en)) { oversize[en] = zh; over++; continue; }
  safe[en] = zh;
  kept++;
}

// 按英文字节长度降序: 补丁时先替长串, 避免长串被短串的子串抢先替换而错位
const sortKeys = obj => {
  const o = {};
  Object.keys(obj).sort((a, b) => byteLen(b) - byteLen(a) || (a < b ? -1 : 1))
    .forEach(k => { o[k] = obj[k]; });
  return o;
};

fs.writeFileSync(OUT, JSON.stringify(sortKeys(safe), null, 0));
fs.writeFileSync(OVER, JSON.stringify(sortKeys(oversize), null, 0));

const report = {
  上游总条数: total,
  等长安全: kept,
  超长跳过: over,
  占位符剔除: placeholder,
  语法不安全剔除: unsafe,
  裸标识符词剔除: bareWord,
  过短剔除: tooShort,
  无效跳过: skipped,
  覆盖率: (kept / (kept + over) * 100).toFixed(1) + '%',
  输出字节: fs.statSync(OUT).size,
};
console.log(JSON.stringify(report, null, 2));
