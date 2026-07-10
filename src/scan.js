'use strict';
// 覆盖扫描: 对纯英文基线测词典命中率, 检测词典是否滞后于 CC 新版,
// 并按运行者身份给出提醒 —— 维护者(工具根目录有 .git, 克隆的仓库)提示
// 更新词典; 普通用户(npm 安装, 无 .git)提示升级工具。

const fs = require('fs');
const path = require('path');
const { looksTranslated, BACKUP_SUFFIX } = require('./patcher');
const { readVersion } = require('./locate');

const ROOT = path.resolve(__dirname, '..');
const SAFE_PATH = path.join(ROOT, 'dict', 'zh-Hans.json');
const OVER_PATH = path.join(ROOT, 'dict', 'oversize.json');

// 词典滞后到什么程度该提醒(纯英文基线上的未命中率)
const LAG_THRESHOLD = 0.2;
// 短词命中次数异常多 → 可能误伤了非目标位置, scan 给告警
const SHORT_KEY_BYTES = 12;
const SHORT_KEY_MAX_HITS = 10;

function isMaintainer() {
  return fs.existsSync(path.join(ROOT, '.git'));
}

// 基线 = 纯英文二进制: 优先用备份; target 本身纯英文也可
function resolveBaseline(target) {
  const backupPath = target + BACKUP_SUFFIX;
  if (fs.existsSync(backupPath)) {
    const b = fs.readFileSync(backupPath);
    if (!looksTranslated(b)) return { buf: b, from: backupPath };
  }
  const t = fs.readFileSync(target);
  if (!looksTranslated(t)) return { buf: t, from: target };
  throw new Error('找不到纯英文基线(target 已汉化且无备份), 无法扫描。请先重装/升级 Claude Code。');
}

function countHits(buf, needle, cap) {
  let n = 0, from = 0, idx;
  while (n < cap && (idx = buf.indexOf(needle, from)) !== -1) {
    n++;
    from = idx + needle.length;
  }
  return n;
}

function scan(target, opts = {}) {
  const { buf, from } = resolveBaseline(target);
  const safe = JSON.parse(fs.readFileSync(SAFE_PATH, 'utf8'));
  const over = fs.existsSync(OVER_PATH) ? JSON.parse(fs.readFileSync(OVER_PATH, 'utf8')) : {};

  const misses = [];
  const shortKeyWarnings = [];
  const safeKeys = Object.keys(safe);
  let hit = 0;
  for (let k = 0; k < safeKeys.length; k++) {
    const en = safeKeys[k];
    const enBuf = Buffer.from(en, 'utf8');
    if (enBuf.length <= SHORT_KEY_BYTES) {
      const n = countHits(buf, enBuf, SHORT_KEY_MAX_HITS + 1);
      if (n > 0) hit++; else misses.push(en);
      if (n > SHORT_KEY_MAX_HITS) shortKeyWarnings.push({ en, hits: '>' + SHORT_KEY_MAX_HITS });
    } else {
      if (buf.indexOf(enBuf) !== -1) hit++; else misses.push(en);
    }
    if (opts.onProgress && (k + 1) % 100 === 0) opts.onProgress(k + 1, safeKeys.length);
  }

  let overHit = 0;
  const overKeys = Object.keys(over);
  for (const en of overKeys) {
    if (buf.indexOf(Buffer.from(en, 'utf8')) !== -1) overHit++;
  }

  const missRate = safeKeys.length ? misses.length / safeKeys.length : 0;
  return {
    target,
    baseline: from,
    version: readVersion(target),
    safeTotal: safeKeys.length,
    safeHit: hit,
    safeMiss: misses.length,
    missRate,
    lagging: missRate > LAG_THRESHOLD,
    oversizeTotal: overKeys.length,
    oversizeStillPresent: overHit,
    misses,
    shortKeyWarnings,
    maintainer: isMaintainer(),
  };
}

// 把扫描结果渲染成给人看的报告文本
function renderReport(r) {
  const lines = [];
  lines.push('基线: ' + r.baseline + (r.version ? ' (Claude Code ' + r.version + ')' : ''));
  lines.push('等长词典: ' + r.safeHit + '/' + r.safeTotal + ' 命中, 未命中 ' + r.safeMiss +
    ' 条 (' + (r.missRate * 100).toFixed(1) + '%)');
  lines.push('超长词典(暂不可用): ' + r.oversizeStillPresent + '/' + r.oversizeTotal + ' 条英文原串仍存在');
  if (r.shortKeyWarnings.length) {
    lines.push('');
    lines.push('⚠ 短词命中异常多(可能误伤非目标位置, 建议人工核查):');
    r.shortKeyWarnings.forEach(w => lines.push('  - ' + JSON.stringify(w.en) + ' 命中 ' + w.hits + ' 次'));
  }
  lines.push('');
  if (r.lagging) {
    if (r.maintainer) {
      lines.push('📌 词典明显滞后于该版本。你是维护者(检测到 .git):');
      lines.push('   在本仓库启动 Claude Code, 让它对照新版二进制补齐未命中词条,');
      lines.push('   更新 dict/sources/cli-translations.json 后重跑 node tools/build-dict.cjs。');
      lines.push('   未命中清单见上方 misses(用 --json 输出完整列表)。');
    } else {
      lines.push('📌 词典明显滞后于你的 Claude Code 版本。');
      lines.push('   请升级本工具获取最新词典: npm update -g cchans');
      lines.push('   (若升级后仍滞后, 欢迎到 GitHub 提 issue: ForceMind/Claude-Code-Chinese-Simplified)');
    }
  } else {
    lines.push('✓ 词典与该版本匹配良好, 未见明显滞后。');
  }
  return lines.join('\n');
}

// 把扫描结果渲染成可直接粘贴给 Claude Code 的翻译任务提示词 ——
// 用户在任意目录启动 CC, 贴入此提示词, CC 即可自动补齐词典并重新打补丁。
function renderPrompt(r) {
  const ver = r.version ? 'v' + r.version : '当前版本';
  const lines = [];
  lines.push('# 任务: 为 cchans 汉化词典补齐 Claude Code ' + ver + ' 的翻译');
  lines.push('');
  lines.push('cchans 是 Claude Code 原生二进制的等长原地汉化工具');
  lines.push('(仓库: https://github.com/ForceMind/Claude-Code-Chinese-Simplified)。');
  lines.push('当前词典对该版本有 ' + r.safeMiss + '/' + r.safeTotal + ' 条未命中 (' +
    (r.missRate * 100).toFixed(1) + '%), 请按下述步骤补齐。');
  lines.push('');
  lines.push('## 硬约束(违反会导致词条无效甚至破坏二进制)');
  lines.push('- 词典源是 dict/sources/cli-translations.json, 格式 [{en, zh}] 数组。');
  lines.push('- 等长约束: 译文 UTF-8 字节数 <= 英文原文字节数; 超长的照常收录即可,');
  lines.push('  build-dict 会自动把它归入 oversize.json 备用, 不会出错。');
  lines.push('- 译文不得引入英文里没有的 " \' ` 反斜杠 ${ 或换行(会破坏 JS 字符串字面量)。');
  lines.push('- 英文串里的字面 \\uXXXX 转义按原样保留, 不要反解成真实字符。');
  lines.push('- 不要收录纯标识符词(如单个单词 Sandbox), build-dict 会剔除。');
  lines.push('');
  lines.push('## 工作步骤');
  lines.push('1. 若当前目录不是 cchans 仓库, 先克隆并进入:');
  lines.push('   git clone https://github.com/ForceMind/Claude-Code-Chinese-Simplified && cd Claude-Code-Chinese-Simplified');
  lines.push('2. 逐条处理下方「未命中清单」: 这些英文串在 ' + ver + ' 的二进制里已消失,');
  lines.push('   通常只是文案微调。在目标二进制中搜索相近片段找到新串(二进制内嵌 JS 源码,');
  lines.push('   可直接文本搜索, 如: rg -a "片段" "' + r.target + '"),');
  lines.push('   把 {en: 新英文串, zh: 中文译文} 追加进 dict/sources/cli-translations.json;');
  lines.push('   确认已彻底移除的文案直接跳过。');
  lines.push('3. 重建词典: node tools/build-dict.cjs');
  lines.push('4. 重新打补丁并验证: node bin/cchans.js patch && node bin/cchans.js scan');
  lines.push('   scan 未命中率应明显下降; patch 报错则说明新词条违反了硬约束, 按报错修正。');
  lines.push('5. 完成后展示: 补了多少条、新的未命中率。若在克隆的仓库中工作,');
  lines.push('   建议提交并发 PR 回上游, 让所有用户受益。');
  lines.push('');
  lines.push('## 目标二进制');
  lines.push(r.target + '  (Claude Code ' + ver + ')');
  lines.push('');
  lines.push('## 未命中清单 (' + r.misses.length + ' 条, JSON 字符串格式)');
  for (const en of r.misses) lines.push('- ' + JSON.stringify(en));
  return lines.join('\n');
}

module.exports = { scan, renderReport, renderPrompt, resolveBaseline, isMaintainer, LAG_THRESHOLD };
