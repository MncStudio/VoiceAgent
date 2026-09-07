'use strict';

// 语法检查:对所有 server/test/*.js、public/voice-agent.js,以及 HTML 内联 <script>
// 逐个跑 `node --check`。运行:npm run check(或 node scripts/check.js)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let failed = 0;

function checkJs(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log('✓', path.relative(process.cwd(), file));
  } catch (e) {
    failed++;
    console.error('✗ 语法错误:', file);
    console.error(String(e.stderr || e.message).trim());
  }
}

// HTML 里首个 <script> 内联块(本项目的页面都只有一个内联块)
function checkInlineScript(htmlFile) {
  const src = fs.readFileSync(htmlFile, 'utf8');
  const m = src.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) return;
  const tmp = `${htmlFile}.inline.js`;
  fs.writeFileSync(tmp, m[1]);
  checkJs(tmp);
  fs.rmSync(tmp, { force: true });
}

for (const f of fs.readdirSync('server')) {
  if (f.endsWith('.js')) checkJs(path.join('server', f));
}
for (const f of fs.readdirSync('test')) {
  if (f.endsWith('.js')) checkJs(path.join('test', f));
}
checkJs(path.join('public', 'voice-agent.js'));
checkInlineScript(path.join('public', 'index.html'));
checkInlineScript(path.join('public', 'config-builder.html'));

if (failed) {
  console.error(`\n${failed} 个文件语法错误`);
  process.exit(1);
}
console.log('\n语法检查全部通过');
