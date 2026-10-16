// Alohida jarayon: stdin — rasm, stdout — fonsiz WebP. Xotira ish tugagach to'liq bo'shaydi.
'use strict';
const { removeBackground, heightMap } = require('./cutout');
const mode = process.argv[2] || 'cutout';
const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', async () => {
  try {
    const input = Buffer.concat(chunks);
    const r = mode === 'depth' ? await heightMap(input) : await removeBackground(input);
    process.stderr.write(JSON.stringify({ coverage: r.coverage, model: r.model }) + '\n');
    process.stdout.write(r.buffer, () => process.exit(0));
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
    process.exit(2);
  }
});
