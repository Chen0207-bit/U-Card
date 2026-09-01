// 浏览器回归代理检查: 页面所有事件处理函数必须在 inline 脚本中有定义(含公共模块委托后的别名)
import { readFileSync } from 'node:fs';
let bad = 0;
for (const f of ['admin', 'app', 'app-pc', 'merchant']) {
  const s = readFileSync('public/' + f + '.html', 'utf8');
  const inline = [...s.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const handlers = new Set();
  const attrRe = /on(?:click|change|input|submit|keyup|keydown)="([a-zA-Z_$][\w$]*)\s*\(/g;
  // 静态标记 + inline 模板串内拼接的属性两种来源
  for (const m of s.matchAll(attrRe)) handlers.add(m[1]);
  for (const m of inline.matchAll(attrRe)) handlers.add(m[1]);
  const missing = [...handlers].filter((fn) => {
    const name = fn.replace(/\$/g, '\\$');
    const def = new RegExp('(^|[^\\w$])(function\\s+' + name + '\\s*\\(|(var|let|const)\\s+' + name + '\\b|' + name + '\\s*[:=]\\s*function)');
    return !def.test(inline);
  });
  if (missing.length) { bad += missing.length; console.log(f + ': MISSING -> ' + missing.join(', ')); }
  else console.log(f + ': all ' + handlers.size + ' handlers defined');
}
if (bad) { console.error('FAIL ' + bad); process.exit(1); }
console.log('===== HANDLER CHECK PASS =====');
