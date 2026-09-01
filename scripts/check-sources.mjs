import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['src', 'test', 'scripts'];
const files = ['core.js', 'server.js', 'worker.js', 'do.js'];
const visit = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(path);
  }
};
for (const root of roots) visit(root);
for (const file of [...new Set(files)].sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} source files.`);
