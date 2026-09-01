// strict-no-fallback 守卫: legacy core.handleApi 兜底已删除, 本测试防止它悄悄回来。
// 两层防护:
//  1) 源码治理: create-app.js 不得引用 core.handleApi, core.js 不得导出 handleApi
//  2) 行为扫描: 以匿名身份遍历 Router 全部注册路由, 任何一条都不得落到"兜底 404"签名
import fs from 'node:fs';
import { createApp } from '../src/app/create-app.js';

let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log('  ✓ ' + name);
  else { fail += 1; console.error('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
};

console.log('\n== 源码治理: 兜底已删除 ==');
const createAppSource = fs.readFileSync(new URL('../src/app/create-app.js', import.meta.url), 'utf8');
check('create-app.js 不再引用 core.handleApi 兜底', !createAppSource.includes('core.handleApi'));
const coreSource = fs.readFileSync(new URL('../core.js', import.meta.url), 'utf8');
check('core.js 不再导出 handleApi', !/\bexport\s+const\s+handleApi\b/.test(coreSource) && !/\bhandleApi,/.test(coreSource));

console.log('\n== 行为扫描: 全部 Router 路由不落兜底 ==');
const app = createApp({ env: { APP_MODE: 'demo', AUTH_MODE: 'demo-header', ALLOW_DEMO_RESET: 'true', CORS_ORIGINS: '*' } });
const fallbackSignature = (pathname) => 'not found: ' + pathname;
let probed = 0;
const misses = [];
for (const entry of app.routes) {
  const space = entry.indexOf(' ');
  const method = entry.slice(0, space);
  const raw = entry.slice(space + 1);
  const isPrefix = raw.endsWith('*');
  const pathname = isPrefix ? raw.slice(0, -1) + 'probe-id' : raw;
  const result = await app.handleApi(method, pathname);
  probed += 1;
  // 匿名身份合法结果为 401/403/400/200 等; 唯独不允许出现兜底 404 签名
  if (result.json?.error === fallbackSignature(pathname)) misses.push(entry);
}
check(`Router ${app.routes.length} 条注册路由全部由 Router 处理(${probed} 次匿名探测)`, misses.length === 0, misses.join(', '));

const unknown = await app.handleApi('GET', '/api/nonexistent/path');
check('未注册路径返回统一 404', unknown.status === 404 && unknown.json?.error === fallbackSignature('/api/nonexistent/path'), JSON.stringify(unknown).slice(0, 120));

console.log(`\n===== NO-FALLBACK PASS ${fail === 0 ? 'OK' : 'NG'} (${fail} FAIL) =====`);
process.exit(fail ? 1 : 0);
