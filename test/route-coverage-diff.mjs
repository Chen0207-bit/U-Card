// Router 与 legacy core.handleApi 路由覆盖差异分析 v2
// - 精确分支带方法信息; 前缀感知 Router 匹配(复刻 dispatch: 精确优先, 最长前缀)
import fs from 'node:fs';
import { createApp } from '../src/app/create-app.js';

const core = fs.readFileSync(new URL('../core.js', import.meta.url), 'utf8');
const app = createApp({ env: { APP_MODE: 'demo', AUTH_MODE: 'demo-header', ALLOW_DEMO_RESET: 'true', CORS_ORIGINS: '*' } });

const exact = new Map();
const prefixes = [];
app.routes.forEach(key => {
  if (key.endsWith('*')) {
    const method = key.slice(0, key.indexOf(' '));
    prefixes.push({ method, prefix: key.slice(key.indexOf(' ') + 1, -1) });
  } else exact.set(key, true);
});
const METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'];
const covered = (method, path) =>
  exact.has(`${method} ${path}`)
  || prefixes.some(route => route.method === method && path.startsWith(route.prefix));

const handleApiStart = core.indexOf('function handleApi');
const handleApiEnd = core.indexOf('\nfunction ', handleApiStart + 10) > 0 ? core.indexOf('\nfunction ', handleApiStart + 10) : core.length;
const body = core.slice(handleApiStart, handleApiEnd);

// 精确分支: p === '...' 可能带 && method === 'X'
const uncoveredExact = [];
const coveredCount = { value: 0 };
[...body.matchAll(/p === '(\/api\/[^']+)'/g)].forEach(m => {
  const path = m[1];
  const after = body.slice(m.index, m.index + 120);
  const methodMatch = after.match(/&& method === '([A-Z]+)'/);
  if (methodMatch) {
    if (covered(methodMatch[1], path)) coveredCount.value += 1;
    else uncoveredExact.push(`${methodMatch[1]} ${path}`);
  } else {
    // 方法不明确: 任一方法被覆盖即视为已覆盖
    if (METHODS.some(method => covered(method, path))) coveredCount.value += 1;
    else uncoveredExact.push(`? ${path}`);
  }
});

console.log(`Router: ${exact.size} 精确 + ${prefixes.length} 前缀`);
console.log(`legacy 精确分支: ${coveredCount.value} 已覆盖, ${uncoveredExact.length} 未覆盖`);
console.log('\n== legacy 精确分支未被 Router 覆盖 ==');
[...new Set(uncoveredExact)].sort().forEach(item => console.log('  ' + item));

// 前缀分支
const legacyPrefixes = [...new Set([...body.matchAll(/p\.startsWith\('(\/api\/[^']*)'\)/g)].map(m => m[1]))];
console.log(`\n== legacy 前缀分支 vs Router 前缀 ==`);
legacyPrefixes.sort().forEach(lp => {
  const routers = prefixes.filter(rp => lp.startsWith(rp.prefix) || rp.prefix.startsWith(lp));
  console.log(`  ${lp}  →  ${routers.length ? routers.map(r => `${r.method} ${r.prefix}*`).join(' | ') : '(无直接对应, 靠精确注册覆盖)'}`);
});

// 正则动态路由
const legacyRegexes = [...new Set([...body.matchAll(/p\.match\((\/[^\s]+\/[a-z]*)\)/g)].map(m => m[1]))];
console.log(`\n== legacy 正则动态路由(${legacyRegexes.length}) → 对应 Router 前缀 ==`);
legacyRegexes.sort().forEach(rx => {
  const m = rx.match(/^\/\^\\\/((?:api|[\w-]+).*?)\$/);
  const asPath = m ? '/' + m[1].replace(/\\\//g, '/') : rx;
  const probe = asPath.replace(/\(\[[^)]*\]\)\+/, '0').replace(/\(\?:/, '').replace(/\)\+.*$/, '').replace(/\.\+/, 'x');
  const routers = prefixes.filter(rp => probe.startsWith(rp.prefix));
  console.log(`  ${rx}${routers.length ? '  →  ' + routers.map(r => `${r.method} ${r.prefix}*`).join(' | ') : '  →  (未发现前缀覆盖, 需人工确认)'}`);
});
