import fs from 'node:fs';
import { minify } from 'terser';

const SOURCE_FILE = 'src/bookmarklet/bookmarklet-source.js';
const TXT_FILE = 'src/bookmarklet/bookmarklet.txt';
const TS_FILE = 'src/bookmarklet/bookmarklet-code.ts';

try {
  const sourceCode = fs.readFileSync(SOURCE_FILE, 'utf8');
  const result = await minify(sourceCode, { compress: { passes: 2 }, mangle: false });
  const minified = result.code;
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
