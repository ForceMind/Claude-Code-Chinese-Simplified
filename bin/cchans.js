#!/usr/bin/env node
'use strict';
// cchans —— Claude Code 汉化工具 CLI(零依赖)
//
//   cchans patch [目标路径]     打补丁(自动定位/备份/幂等)
//   cchans restore [目标路径]   还原纯英文
//   cchans status [目标路径]    查看当前状态
//   cchans scan [目标路径]      覆盖扫描 + 词典滞后诊断(--json 原始结果 / --prompt 生成翻译任务提示词)
//   cchans locate               只定位二进制
//
// 目标路径可省略(自动定位), 也可用环境变量 CCHANS_TARGET 指定。

const { locate } = require('../src/locate');
const patcher = require('../src/patcher');
const scanner = require('../src/scan');

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = new Set(argv.filter(a => a.startsWith('--')));
const explicit = argv.slice(1).find(a => !a.startsWith('--'));

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

function requireTarget() {
  const found = locate(explicit);
  if (!found) {
    fail('找不到 Claude Code 二进制。可显式指定: cchans ' + cmd + ' <claude.exe 路径>\n' +
      '  (要求: Bun 编译的原生二进制, 体积 > 20MB)');
  }
  console.log('目标: ' + found.path + (found.version ? ' (v' + found.version + ')' : ''));
  return found;
}

const progress = label => (done, total, extra) => {
  process.stderr.write('\r' + label + ' ' + done + '/' + total + (extra !== undefined ? ', 命中 ' + extra : '') + '   ');
};
const endProgress = () => process.stderr.write('\r' + ' '.repeat(60) + '\r');

try {
  switch (cmd) {
    case 'patch': {
      const { path: target } = requireTarget();
      console.log('打补丁中(全量扫描约 1 分钟, 请稍候)…');
      const r = patcher.patch(target, { onProgress: progress('词条') });
      endProgress();
      console.log('✓ 完成: ' + r.keysHit + '/' + r.dictTotal + ' 词条命中, 共替换 ' + r.occurrences +
        ' 处(词边界守卫跳过 ' + r.boundarySkips + ' 处代码内命中), 耗时 ' + r.seconds.toFixed(1) + 's');
      if (r.backupRefreshed) console.log('  已刷新纯英文备份(跟随当前版本)。');
      if (r.resigned === false) {
        console.log('⚠ macOS 重签名失败: 请手动执行 codesign --force --sign - "' + target + '"');
        console.log('  否则系统可能拒绝运行改写后的二进制。');
      }
      const missed = r.dictTotal - r.keysHit;
      if (missed / r.dictTotal > scanner.LAG_THRESHOLD) {
        console.log('📌 有 ' + missed + ' 条词条未命中, 词典可能滞后于该版本。');
        console.log('   运行 cchans scan --prompt 生成翻译任务提示词, 粘贴给 Claude Code 即可自动补齐。');
      }
      console.log('  还原命令: cchans restore');
      break;
    }
    case 'restore': {
      const { path: target } = requireTarget();
      const r = patcher.restore(target);
      console.log('✓ 已还原纯英文: ' + r.restoredFrom + ' -> ' + target);
      break;
    }
    case 'status': {
      const { path: target } = requireTarget();
      const s = patcher.status(target);
      console.log('  版本: ' + (s.version || '未知'));
      console.log('  体积: ' + (s.size / 1024 / 1024).toFixed(1) + ' MB');
      console.log('  状态: ' + (s.translated ? '已汉化' : '纯英文'));
      console.log('  备份: ' + (s.hasBackup ? '有(.cchans-backup)' : s.hasZhCnBackup ? '有(.zh-cn-backup, 可收编)' : '无'));
      break;
    }
    case 'scan': {
      const { path: target } = requireTarget();
      console.log('扫描中(约半分钟)…');
      const r = scanner.scan(target, { onProgress: progress('词条') });
      endProgress();
      if (flags.has('--json')) {
        console.log(JSON.stringify(r, null, 2));
      } else if (flags.has('--prompt')) {
        const out = require('path').resolve('cchans-translate-task.md');
        require('fs').writeFileSync(out, scanner.renderPrompt(r));
        console.log(scanner.renderReport(r));
        console.log('');
        console.log('✓ 翻译任务提示词已写入: ' + out);
        console.log('  在任意目录启动 Claude Code, 把该文件内容(或 @引用它)交给 CC 即可自动补齐词典。');
      } else {
        console.log(scanner.renderReport(r));
      }
      break;
    }
    case 'locate': {
      requireTarget();
      break;
    }
    default:
      console.log([
        'cchans —— Claude Code 汉化工具(等长原地补丁, 零依赖, 跟随新版)',
        '',
        '用法:',
        '  cchans patch [路径]     打补丁(自动定位/备份/可重复执行)',
        '  cchans restore [路径]   还原纯英文',
        '  cchans status [路径]    查看状态',
        '  cchans scan [路径]      覆盖扫描 + 词典滞后诊断(--json 完整输出 / --prompt 生成翻译任务提示词)',
        '  cchans locate           定位 Claude Code 二进制',
      ].join('\n'));
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  endProgress();
  fail(e.message);
}
