import fs from 'node:fs';
import { minify } from 'terser';

const bookmarklets = [
  {
    source: 'src/bookmarklet/bookmarklet-source.js',
    txt: 'src/bookmarklet/bookmarklet.txt',
    ts: 'src/bookmarklet/bookmarklet-code.ts',
    exportName: 'bookmarkletCode',
  },
  {
    source: 'src/bookmarklet/open-in-docreview-source.js',
    txt: 'src/bookmarklet/open-in-docreview.txt',
    ts: 'src/bookmarklet/open-in-docreview-code.ts',
    exportName: 'openInDocreviewCode',
  },
];

try {
  for (const b of bookmarklets) {
    const sourceCode = fs.readFileSync(b.source, 'utf8');
    const result = await minify(sourceCode, { compress: { passes: 2 }, mangle: false });
    const minified = result.code;
    const bookmarklet = `javascript:${minified}`;

    fs.writeFileSync(b.txt, bookmarklet);
    console.log(`Updated ${b.txt}`);

    const escaped = minified.replace(/\\/g, '\\\\');
    const tsContent = `// Automatically generated from ${b.source.split('/').pop()}. Do not edit directly.\nexport const ${b.exportName} = \`${escaped}\`;\n`;
    fs.writeFileSync(b.ts, tsContent);
    console.log(`Updated ${b.ts}`);
  }
} catch (err) {
  console.error('Failed to build bookmarklet:', err);
  process.exit(1);
}
