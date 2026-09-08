import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const files = [];
async function walk(dir) { for (const e of await readdir(dir, { withFileTypes: true })) { const path = `${dir}/${e.name}`; if (e.isDirectory()) await walk(path); else if (/\.(js|mjs|json|css|html|md|py)$/.test(e.name)) files.push(path); } }
for (const dir of ['src', 'ui', 'tests', 'scripts', 'vendor']) await walk(dir);
files.push('index.js', 'manifest.json', 'package.json', 'style.css');
let errors = 0;
for (const file of files) {
    if (/\.(js|mjs)$/.test(file) && !process.argv.includes('--whitespace-only')) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    if (file.startsWith('vendor/')) continue;
    const text = await readFile(file, 'utf8');
    text.split(/\r?\n/).forEach((line, i) => { if (/[\t ]+$/.test(line)) { console.error(`${file}:${i + 1}: trailing whitespace`); errors++; } });
}
if (errors) process.exitCode = 1; else console.log(`Syntax and whitespace checked: ${files.length} files`);
