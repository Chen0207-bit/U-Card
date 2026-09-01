import { createApp } from '../src/app/create-app.js';
import { createConfig } from '../src/config.js';
import { corsHeaders } from '../src/runtime/http.js';
import { resolveStaticPath } from '../src/runtime/static-routes.js';

let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
};

console.log('\n== 架构边界 ==');
const demo = createApp({ env: { APP_MODE: 'demo', AUTH_MODE: 'demo-header', ALLOW_DEMO_RESET: 'true', CORS_ORIGINS: '*' } });
check('首批 router 注册 4 条运维路由', demo.routes.length === 4, demo.routes.join(','));

let r = await demo.handleApi('GET', '/api/admin/users');
check('后台无身份返回 401', r.status === 401, JSON.stringify(r));
r = await demo.handleApi('GET', '/api/admin/accounts');
check('Demo 账号选择列表允许匿名访问', r.status === 200 && Array.isArray(r.json), JSON.stringify(r).slice(0, 100));
r = await demo.handleApi('GET', '/api/admin/ops/backup', {}, {}, { 'x-sales': '30' });
check('普通销售不能导出运维备份', r.status === 403, JSON.stringify(r));
r = await demo.handleApi('GET', '/api/admin/ops/data-state', {}, {}, { 'x-sales': '1' });
check('总监可读取数据状态', r.status === 200 && r.json.persistence === 'none', JSON.stringify(r).slice(0, 120));
r = await demo.handleApi('GET', '/api/app/me');
check('用户端无身份返回 401', r.status === 401, JSON.stringify(r));
r = await demo.handleApi('GET', '/api/app/me', {}, {}, { 'x-user': '1' });
check('Demo 用户身份兼容', r.status === 200 && r.json.id === 1, JSON.stringify(r).slice(0, 100));

const production = createConfig({ APP_MODE: 'production' });
check('生产模式默认 session 且禁止 reset', production.authMode === 'session' && production.allowDemoReset === false, JSON.stringify(production));
let rejected = false;
try { createConfig({ APP_MODE: 'production', AUTH_MODE: 'demo-header' }); } catch { rejected = true; }
check('生产模式拒绝 demo-header', rejected);

const cors = corsHeaders(createConfig({ APP_MODE: 'production', CORS_ORIGINS: 'https://console.example.com' }), 'https://evil.example.com');
check('生产 CORS 不回显未授权 Origin', !('Access-Control-Allow-Origin' in cors), JSON.stringify(cors));

check('PC /app 分流', resolveStaticPath('/app', 'Mozilla/5.0') === '/app-pc.html');
check('Mobile /app 分流', resolveStaticPath('/app', 'Mozilla/5.0 iPhone') === '/app.html');
check('商户入口统一映射', resolveStaticPath('/merchant') === '/merchant.html');
check('数据控制台入口统一映射', resolveStaticPath('/data-console') === '/data-console.html');

console.log(`\n===== ARCH PASS ${pass} FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
