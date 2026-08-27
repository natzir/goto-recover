// Builds dist/goto-recover.min.js, dist/bookmarklet.txt and dist/index.html from src/goto-recover.js
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'src/goto-recover.js'), 'utf8');
  const { code } = await minify(src, {
    compress: { passes: 2 },
    mangle: true,
    format: { comments: false, ascii_only: true }
  });

  // Readable copy without comments.
  const { code: plain } = await minify(src, {
    compress: false,
    mangle: false,
    format: { comments: false, beautify: true, indent_level: 2 }
  });

  // A javascript: URL is percent-decoded before it runs, so literal % must be escaped.
  const bookmarklet = 'javascript:' + code.replace(/%/g, '%25');
  // Variant that also sends domain-only links to the site root.
  const bookmarkletRoot = 'javascript:window.__gotoRecoverOptions={domainFallback:true};' + code.replace(/%/g, '%25');
  const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  const html = `<!doctype html>
<meta charset="utf-8">
<title>goto-recover</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px}a.b{display:inline-block;padding:10px 16px;border:1px solid #333;border-radius:6px;text-decoration:none;color:#111;background:#f4f4f4}code{background:#eee;padding:1px 4px}</style>
<h1>goto-recover</h1>
<p>Restores the destination URLs behind Google Search <code>/goto?url=</code> links, using data already present in the page.</p>
<p>Drag this button to your bookmarks bar, then click it on any Google results page:</p>
<p><a class="b" href="${attr(bookmarklet)}">goto-recover</a></p>
<p>Or create a bookmark by hand and paste the contents of <code>bookmarklet.txt</code> as its URL.</p>
<h2>Variant: domain fallback</h2>
<p>Same, but links whose record only exposes the domain are sent to the site root instead of being left alone. That is not the page Google would send you to; use it when you prefer any direct link over a tracked one.</p>
<p><a class="b" href="${attr(bookmarkletRoot)}">goto-recover (domain fallback)</a></p>
`;

  const dist = path.join(__dirname, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'goto-recover.min.js'), code + '\n');
  fs.writeFileSync(path.join(dist, 'goto-recover.js'), plain + '\n');
  fs.writeFileSync(path.join(dist, 'bookmarklet.txt'), bookmarklet + '\n');
  fs.writeFileSync(path.join(dist, 'bookmarklet-domain-fallback.txt'), bookmarkletRoot + '\n');
  fs.writeFileSync(path.join(dist, 'index.html'), html);
  console.log(`min ${code.length} bytes, bookmarklet ${bookmarklet.length} bytes`);
})().catch((e) => { console.error(e); process.exit(1); });
