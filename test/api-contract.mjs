// 3.0 API 字面路径契约。重构可以改变内部实现，但路径集合变化必须显式更新基线。
import fs from 'node:fs';
import crypto from 'node:crypto';

const source = fs.readFileSync(new URL('../core.js', import.meta.url), 'utf8');
const routes = [...new Set(
  [...source.matchAll(/["'](\/api\/[^"']+)["']/g)].map((m) => m[1]),
)].sort();

const baseline = {
  count: 161,
  sha256: 'f6706ff0fadaef6d871ec03b21a604e5c5bad857bc2e3e9be028f68e6c015099',
  groups: { admin: 124, app: 25, merchant: 7, open: 2, other: 3 },
};

const groupOf = (p) => p.startsWith('/api/admin/') ? 'admin'
  : p.startsWith('/api/app/') ? 'app'
    : p.startsWith('/api/mch/') ? 'merchant'
      : p.startsWith('/api/open/') ? 'open' : 'other';
const groups = Object.fromEntries(Object.keys(baseline.groups).map((key) => [key, 0]));
routes.forEach((p) => { groups[groupOf(p)] += 1; });
const sha256 = crypto.createHash('sha256').update(routes.join('\n')).digest('hex');

const problems = [];
if (routes.length !== baseline.count) problems.push(`路径数 ${routes.length} != ${baseline.count}`);
if (sha256 !== baseline.sha256) problems.push(`路径哈希 ${sha256} != ${baseline.sha256}`);
for (const [key, value] of Object.entries(baseline.groups)) {
  if (groups[key] !== value) problems.push(`${key} 路径数 ${groups[key]} != ${value}`);
}

if (problems.length) {
  console.error('API contract drift:');
  problems.forEach((p) => console.error(' - ' + p));
  console.error('如为有意变更，请审查路径差异后更新 test/api-contract.mjs 与 docs/api-contract-baseline.md。');
  process.exit(1);
}

console.log(`API contract PASS: ${routes.length} paths, sha256=${sha256}`);
console.log(groups);
