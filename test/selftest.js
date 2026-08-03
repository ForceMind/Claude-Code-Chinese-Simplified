#!/usr/bin/env node
'use strict';
// cchans 自测 —— 零依赖, 直接 `node test/selftest.js` 即可。
//
// 为什么需要它: 本工具的正确性依赖若干**只写在注释里**的微妙不变量(替换过程不改变
// NUL 结构、cleanAside 必须在 resolveSource 之后、healMissing 必须在 isClaudeBinary
// 之前、前缀匹配必须精确…)。2026-08-03 一天之内四轮审查, 每轮都在"我以为收敛了"
// 之后又挖出 P0, 其中多条正是这些不变量被无意破坏所致。注释拦不住下一个改代码的人,
// 断言可以。
//
// 全部用合成数据, 不碰用户的 claude.exe, 不需要网络, 秒级完成。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const patcher = require('../src/patcher');
const locate = require('../src/locate');

let passed = 0, failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push('  ✓ ' + name);
  } catch (e) {
    failed++;
    results.push('  ✗ ' + name + '\n      ' + (e && e.message ? e.message.split('\n')[0] : e));
  }
}

// ── 合成一个"像 Bun 二进制"的最小样本 ────────────────────────────────────
// isClaudeBinary 要求: 是文件 / >20MB / 尾部 64KB 含 Bun 魔术串。
function makeFakeBinary(extra) {
  const SIZE = 21 * 1024 * 1024;
  const buf = Buffer.alloc(SIZE, 0x41); // 'A' 填充
  const trailer = Buffer.from('\n---- Bun! ----\n');
  trailer.copy(buf, SIZE - trailer.length);
  if (extra) extra(buf);
  return buf;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cchans-selftest-'));
const cleanup = [];
function scratchDir(name) {
  const d = path.join(tmpRoot, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ── 1. 原生常量池守卫 ────────────────────────────────────────────────────
// 事故机理: 链接器把短标识符与"以它结尾的长消息"共享存储(尾部合并), 覆写消息尾部
// 会摧毁那个标识符。守卫必须认出"NUL 分隔的紧凑 C 串表"并跳过。

test('inNativePool: 认出 NUL 分隔的紧凑 C 串表', () => {
  const buf = Buffer.from('\0oncancel\0could not find stream to cancel\0preventCancel\0flowlabel\0', 'latin1');
  const idx = buf.indexOf('to cancel');
  assert.strictEqual(patcher.inNativePool(buf, idx, 'to cancel'.length), true);
});

test('inNativePool: 不误伤普通界面文案(无 NUL 邻域)', () => {
  const s = 'some UI text here Press Esc to cancel and more text follows here';
  const buf = Buffer.from(s, 'latin1');
  const idx = buf.indexOf('to cancel');
  assert.strictEqual(patcher.inNativePool(buf, idx, 'to cancel'.length), false);
});

test('inNativePool: 不误伤被长 NUL 填充包围的常量池(Bun 的 {ptr,len} 区)', () => {
  const buf = Buffer.concat([
    Buffer.alloc(64, 0), Buffer.from('Press Esc to cancel', 'latin1'), Buffer.alloc(64, 0),
  ]);
  const idx = buf.indexOf('to cancel');
  assert.strictEqual(patcher.inNativePool(buf, idx, 'to cancel'.length), false);
});

// ── 2. 等长替换的核心不变量 ──────────────────────────────────────────────

test('patchBuffer: 长度不变', () => {
  const buf = Buffer.from('xx Delete hook yy', 'latin1');
  const before = buf.length;
  patcher.patchBuffer(buf, { 'Delete hook': '删除钩子' });
  assert.strictEqual(buf.length, before);
});

test('patchBuffer: 中文写入槽位起始, 余下用空格填充', () => {
  const buf = Buffer.from('[Delete hook]', 'latin1');
  patcher.patchBuffer(buf, { 'Delete hook': '删钩' });
  const slot = buf.slice(1, 1 + 'Delete hook'.length);
  assert.ok(slot.toString('utf8').startsWith('删钩'), '槽位应以中文开头');
  assert.ok(/ +$/.test(slot.toString('utf8')), '余下应为空格填充');
});

test('patchBuffer: 不改变 NUL 结构(inNativePool 依赖的不变量)', () => {
  const buf = Buffer.from('a\0Delete hook\0b\0c\0d', 'latin1');
  const nulsBefore = [...buf.keys()].filter(i => buf[i] === 0);
  patcher.patchBuffer(buf, { 'Delete hook': '删钩' });
  const nulsAfter = [...buf.keys()].filter(i => buf[i] === 0);
  assert.deepStrictEqual(nulsAfter, nulsBefore);
});

test('patchBuffer: 词边界守卫跳过标识符内部命中', () => {
  const buf = Buffer.from('SandboxNetworkAccess', 'latin1');
  const r = patcher.patchBuffer(buf, { 'Sandbox': '沙盒' });
  assert.strictEqual(r.occurrences, 0, '标识符内部不应被替换');
  assert.strictEqual(buf.toString('latin1'), 'SandboxNetworkAccess');
});

test('patchBuffer: 拒绝含 NUL 的译文(否则破坏守卫的不变量)', () => {
  const buf = Buffer.from('[Delete hook]', 'latin1');
  const r = patcher.patchBuffer(buf, { 'Delete hook': '删\0钩' });
  assert.strictEqual(r.occurrences, 0);
});

// ── 3. 已汉化检测 ────────────────────────────────────────────────────────

test('looksTranslated: 纯英文判为 false', () => {
  assert.strictEqual(patcher.looksTranslated(Buffer.from('hello world '.repeat(500))), false);
});

test('looksTranslated: 大量中文判为 true', () => {
  assert.strictEqual(patcher.looksTranslated(Buffer.from('这是中文界面文案。'.repeat(200))), true);
});

// ── 4. 让位副本的前缀匹配必须精确 ────────────────────────────────────────
// 曾用 startsWith, 会把用户的 claude.exe.cchans-older-notes.txt 也算进来 ——
// cleanAside 会删掉它, healMissing 更严重: 会把它 rename 成 claude.exe。

test('cleanAside: 只回收真正的让位副本, 不碰同前缀的用户文件', () => {
  const d = scratchDir('aside');
  const t = path.join(d, 'claude.exe');
  fs.writeFileSync(t, 'x');
  const keep = ['claude.exe.cchans-older-notes.txt', 'claude.exe.cchans-oldest.exe',
                'claude.exe.cchans-backup', 'claude.exe.bak'];
  const drop = ['claude.exe.cchans-old', 'claude.exe.cchans-old.1700000000000'];
  for (const n of [...keep, ...drop]) fs.writeFileSync(path.join(d, n), 'x');
  patcher.cleanAside(t);
  for (const n of keep) assert.ok(fs.existsSync(path.join(d, n)), '不该删: ' + n);
  for (const n of drop) assert.ok(!fs.existsSync(path.join(d, n)), '该删: ' + n);
});

test('healMissing: 不把同前缀的用户文件冒名顶替成 claude.exe', () => {
  const d = scratchDir('heal-decoy');
  const t = path.join(d, 'claude.exe');
  fs.writeFileSync(path.join(d, 'claude.exe.cchans-older-archive.exe'), makeFakeBinary());
  assert.strictEqual(locate.healMissing(t), false);
  assert.ok(!fs.existsSync(t), '不应凭空造出 claude.exe');
});

test('healMissing: 能从真正的让位副本恢复', () => {
  const d = scratchDir('heal-ok');
  const t = path.join(d, 'claude.exe');
  fs.writeFileSync(t + '.cchans-old.1700000000000', makeFakeBinary());
  assert.strictEqual(locate.healMissing(t), true);
  assert.ok(fs.existsSync(t));
});

test('healMissing: 拒绝损坏的让位副本', () => {
  const d = scratchDir('heal-bad');
  const t = path.join(d, 'claude.exe');
  fs.writeFileSync(t + '.cchans-old.1700000000000', Buffer.alloc(1024, 0x41)); // 太小, 无魔术串
  assert.strictEqual(locate.healMissing(t), false);
  assert.ok(!fs.existsSync(t));
});

// ── 5. 显式路径必须权威 ──────────────────────────────────────────────────
// 曾经校验不过就静默回落到自动探测, 结果误改了另一个安装位置的 claude.exe。

test('locate: 显式路径无效时返回 null, 绝不改打别的安装', () => {
  const d = scratchDir('pinned');
  const bogus = path.join(d, 'not-a-claude.exe');
  fs.writeFileSync(bogus, 'hello');
  assert.strictEqual(locate.locate(bogus), null);
});

test('locate: 只读命令(heal 未开启)不得改文件系统', () => {
  const d = scratchDir('readonly-locate');
  const t = path.join(d, 'claude.exe');
  const aside = t + '.cchans-old.1700000000000';
  fs.writeFileSync(aside, makeFakeBinary());
  locate.locate(t); // 不传 heal
  assert.ok(fs.existsSync(aside), '让位副本不应被 rename');
  assert.ok(!fs.existsSync(t), '不应凭空恢复出 claude.exe');
});

// ── 6. 备份完整性锚 ──────────────────────────────────────────────────────

test('backupIntact: 无锚时放行(兼容存量用户)', () => {
  const d = scratchDir('anchor-none');
  const b = path.join(d, 'claude.exe.cchans-backup');
  const buf = Buffer.from('content');
  fs.writeFileSync(b, buf);
  assert.strictEqual(patcher.backupIntact(b, buf), true);
});

test('backupIntact: 锚对得上则通过, 对不上则拦截', () => {
  const d = scratchDir('anchor-mix');
  const b = path.join(d, 'claude.exe.cchans-backup');
  const buf = Buffer.from('content');
  fs.writeFileSync(b, buf);
  const crypto = require('crypto');
  fs.writeFileSync(b + '.sha256', crypto.createHash('sha256').update(buf).digest('hex'));
  assert.strictEqual(patcher.backupIntact(b, buf), true);
  assert.strictEqual(patcher.backupIntact(b, Buffer.from('tampered')), false);
});

test('backupIntact: 锚内容非法时放行(降级而非误伤)', () => {
  const d = scratchDir('anchor-junk');
  const b = path.join(d, 'claude.exe.cchans-backup');
  const buf = Buffer.from('content');
  fs.writeFileSync(b, buf);
  fs.writeFileSync(b + '.sha256', 'not-a-hash');
  assert.strictEqual(patcher.backupIntact(b, buf), true);
});

// ── 7. 词典构建的安全过滤 ────────────────────────────────────────────────

test('词典: 所有译文的 UTF-8 字节数 <= 英文原文(等长替换的前提)', () => {
  const dict = patcher.loadDict();
  const bad = Object.entries(dict).filter(([en, zh]) =>
    Buffer.byteLength(zh, 'utf8') > Buffer.byteLength(en, 'utf8'));
  assert.deepStrictEqual(bad, [], '发现超长词条: ' + JSON.stringify(bad.slice(0, 3)));
});

test('词典: 不含控制字符(NUL 会破坏原生池守卫的不变量)', () => {
  const dict = patcher.loadDict();
  const bad = Object.entries(dict).filter(([, zh]) => /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(zh));
  assert.deepStrictEqual(bad, [], '发现含控制字符的译文');
});

test('词典: 按英文字节长度降序(先替长串, 避免子串抢先命中)', () => {
  const keys = Object.keys(patcher.loadDict());
  for (let i = 1; i < keys.length; i++) {
    assert.ok(Buffer.byteLength(keys[i - 1]) >= Buffer.byteLength(keys[i]),
      '顺序错乱于 #' + i + ': ' + JSON.stringify(keys[i - 1]) + ' -> ' + JSON.stringify(keys[i]));
  }
});

// ── 汇总 ────────────────────────────────────────────────────────────────
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

console.log('cchans 自测\n');
console.log(results.join('\n'));
console.log('\n通过 ' + passed + ' / 失败 ' + failed);
process.exit(failed ? 1 : 0);
