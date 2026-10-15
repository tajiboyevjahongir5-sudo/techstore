// Alohida jarayon: stdin — rasm, stdout — fonsiz WebP. Xotira ish tugagach to'liq bo'shaydi.
'use strict';
const { removeBackground } = require('./cutout');
const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', async () => {
  try {
    const r = await removeBackground(Buffer.concat(chunks));
    process.stderr.write(JSON.stringify({ coverage: r.coverage }) + '\n');
    process.stdout.write(r.buffer, () => process.exit(0));
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
    process.exit(2);
  }
});
