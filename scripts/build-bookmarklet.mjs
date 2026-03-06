import fs from 'node:fs';
import path from 'node:path';

const SOURCE_FILE = 'src/bookmarklet/bookmarklet-source.js';
const TXT_FILE = 'src/bookmarklet/bookmarklet.txt';
const TS_FILE = 'src/bookmarklet/bookmarklet-code.ts';

function minify(code) {
  return code
    .replace(/\/\*\*[\s\S]*?\*\/|(?<=[^:])\/\/.*/g, '')   // Remove comments, avoid // in http://
    .replace(/\s+/g, ' ')                                 // Collapse whitespace
    .replace(/\s*([;=(){},+])\s*/g, '$1')                 // Remove space around operators/delimiters
    .trim();
}

try {
  const sourceCode = fs.readFileSync(SOURCE_FILE, 'utf8');
  const minified = minify(sourceCode);
  const bookmarklet = `javascript:${minified}`;

  // 1. Update bookmarklet.txt
  fs.writeFileSync(TXT_FILE, bookmarklet);
  console.log(`Updated ${TXT_FILE}`);

  // 2. Update bookmarklet-code.ts
  const escaped = minified.replace(/\\/g, '\\\\');
  const tsContent = `// Automatically generated from bookmarklet-source.js. Do not edit directly.\nexport const bookmarkletCode = \`${escaped}\`;\n`;
  fs.writeFileSync(TS_FILE, tsContent);
  console.log(`Updated ${TS_FILE}`);

} catch (err) {
  console.error('Failed to build bookmarklet:', err);
  process.exit(1);
}
