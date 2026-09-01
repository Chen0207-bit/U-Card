// 一次性使用: 按锚文本删除 core.js handleApi 内的 legacy 分支段
// 用法: node scripts/delete-legacy-range.mjs <startAnchor> <endAnchorExclusive>
// 删除 [startAnchor 行, endAnchorExclusive 行) —— 两锚均需在文件中唯一
import fs from 'node:fs';

const [startAnchor, endAnchor] = process.argv.slice(2);
if (!startAnchor || !endAnchor) { console.error('need start/end anchors'); process.exit(2); }
const path = new URL('../core.js', import.meta.url);
const lines = fs.readFileSync(path, 'utf8').split('\n');
const starts = lines.map((l, i) => l.includes(startAnchor) ? i : -1).filter(i => i >= 0);
const ends = lines.map((l, i) => l.includes(endAnchor) ? i : -1).filter(i => i >= 0);
if (starts.length !== 1 || ends.length !== 1) {
  console.error(`anchor not unique: start ${JSON.stringify(starts)}, end ${JSON.stringify(ends)}`);
  process.exit(1);
}
const [s] = starts; const [e] = ends;
if (s >= e) { console.error(`bad range ${s}..${e}`); process.exit(1); }
const removed = lines.splice(s, e - s);
fs.writeFileSync(path, lines.join('\n'));
console.log(`removed lines ${s + 1}..${e} (${removed.length} lines)`);
console.log('first removed:', removed[0].trim().slice(0, 80));
console.log('last removed:', removed[removed.length - 1].trim().slice(0, 80));
