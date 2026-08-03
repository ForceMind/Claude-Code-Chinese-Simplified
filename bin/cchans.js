#!/usr/bin/env node
'use strict';
// cchans —— Claude Code 汉化工具 CLI(零依赖)
//
//   cchans patch [目标路径]     打补丁(自动定位/备份/幂等; --no-verify 跳过实跑验证)
//   cchans restore [目标路径]   还原纯英文
//   cchans status [目标路径]    查看当前状态
//   cchans scan [目标路径]      覆盖扫描 + 词典滞后诊断(--json 原始结果 / --prompt 生成翻译任务提示词)
//   cchans locate               只定位二进制
//
// 目标路径可省略(自动定位), 也可用环境变量 CCHANS_TARGET 指定。

const { locate, healable } = require('../src/locate');
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

// 只有会改写目标的命令才允许自愈(rename 让位副本); status/scan/locate 保持只读
const MUTATING = new Set(['patch', 'restore']);

function requireTarget() {
  const pinned = explicit || process.env.CCHANS_TARGET;
  const found = locate(explicit, { heal: MUTATING.has(cmd) });
  if (!found) {
    let extra = '';
    if (pinned) {
      extra = '\n  注意: 你显式指定了 ' + pinned + '\n' +
              '  该路径不是有效的 Claude Code 二进制。为避免误伤别的安装位置, 本工具\n' +
              '  不会自动改打其他路径 —— 请核对路径后重试。';
      const cands = healable(pinned); // 与 healMissing 同一套筛选(精确前缀 + 有效二进制)
      if (cands) {
        const newest = cands.map(p => {
          let t = 0; try { t = require('fs').statSync(p).mtimeMs; } catch {}
          return { p, t };
        }).sort((a, b) => b.t - a.t)[0].p;
        extra += '\n  发现同目录存在让位副本(上次替换可能被中断):\n' +
                 cands.map(p => '    ' + require('path').basename(p)).join('\n') +
                 '\n  可手动恢复(最新的一份): ' + (process.platform === 'win32' ? 'move /y' : 'mv -f') +
                 ' "' + newest + '" "' + pinned + '"';
      }
    }
    fail('找不到 Claude Code 二进制。可显式指定: cchans ' + cmd + ' <claude.exe 路径>\n' +
      '  (要求: Bun 编译的原生二进制, 体积 > 20MB)' + extra);
  }
  if (found.healed) {
    console.log('已自愈: 上次替换被中断导致二进制缺失, 已从让位副本恢复。');
  } else if (found.healable) {
    console.log('提示: 同目录存在让位副本, 上次替换可能被中断。跑一次 cchans patch/restore 会自动恢复。');
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
      if (flags.has('--no-verify')) {
        console.log('⚠ 已关闭实跑验证(--no-verify)。');
        console.log('  这是本工具唯一能拦住"补丁把二进制改坏"的安全网 —— 关掉它意味着');
        console.log('  一个跑不起来的 claude 可能直接盖掉你现在能用的那个。仅在明知后果时使用。');
      }
      console.log('打补丁中(扫描主模块源码区约半分钟, 请稍候)…');
      const r = patcher.patch(target, {
        onProgress: progress('词条'),
        verify: !flags.has('--no-verify'),
        onVerify: () => { endProgress(); console.log('验证中(实跑补丁产物, 约 10s)…'); },
      });
      endProgress();
      console.log('✓ 完成: ' + r.keysHit + '/' + r.dictTotal + ' 词条命中, 共替换 ' + r.occurrences +
        ' 处(守卫跳过: 标识符内 ' + r.boundarySkips + ' 处 / 原生常量池 ' + r.poolSkips +
        ' 处), 耗时 ' + r.seconds.toFixed(1) + 's');
      console.log(r.verified ? '  运行验证: 通过(--version + doctor + mcp list 实跑)'
                             : '  运行验证: 已跳过(--no-verify) —— 不保证产物能启动');
      if (r.movedAside) {
        console.log('  注意: 目标正在运行, 已热替换(旧映像暂留 .cchans-old.*, 下次 patch 自动清理)。');
      }
      console.log('  已在运行的 Claude Code 仍用旧映像, 需重启它们才会变中文。');
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
      if (r.movedAside) {
        console.log('  注意: 目标正在运行, 已热替换(旧映像暂留 .cchans-old.*, 下次 patch 自动清理)。');
      }
      console.log('  已在运行的 Claude Code 仍用旧映像(中文), 需重启它们才会变回英文。');
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
        '  cchans patch [路径]     打补丁(自动定位/备份/可重复执行/实跑验证)',
        '                          --no-verify 跳过实跑验证(不推荐, 不保证产物能启动)',
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
