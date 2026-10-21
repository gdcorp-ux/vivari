// Manual browser regression for the built SDK. Requires Playwright (or set
// VV_PLAYWRIGHT_MODULE to its module URL). Writes evidence under core/node_modules.
// node scripts/repro-preview-config.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.VV_PLAYWRIGHT_MODULE || "playwright");
const dist = new URL("../packages/core/dist/", import.meta.url);
const evidence = new URL("../node_modules/.cache/s1-evidence/", dist);
fs.mkdirSync(evidence, { recursive: true });
const scriptJson = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const html = `<!doctype html><title>Preview routing regression</title><iframe id="preview"></iframe><script type="module">
import { Vivari } from '/sdk/index.js';
window.run = async () => {
  window.vm = await Vivari.boot({ documentIsolationPolicy: 'none' });
  await vm.mount({ 'server.cjs': { file: { contents: ${scriptJson(`const http = require('http');
const moduleSource = 'document.body.dataset.source = "preview-folder-loaded";';
http.createServer((req, res) => {
  if (req.url === '/src/components/preview/Thing.tsx') { res.setHeader('content-type', 'text/javascript'); res.end(moduleSource); return; }
  res.setHeader('content-type', 'text/html');
  if (req.url === '/nested') { res.end('<!doctype html><h1>Nested frame loaded</h1>'); return; }
  res.end('<!doctype html><h1>Source folder test</h1><script type="module" src="/src/components/preview/Thing.tsx"></script><iframe src="/preview/5601/nested"></iframe>');
}).listen(5601, '127.0.0.1');`)} } } }, { mountPoint: '/app' });
  const ready = vm.once('server-ready');
  window.dev = await vm.spawn('node', ['server.cjs'], { cwd: '/app' });
  dev.output.pipeTo(new WritableStream({ write(s) { console.log(s); } }));
  const [port, url] = await ready;
  const frame = document.querySelector('#preview');
  vm.attachPreview(frame); frame.src = url;
  const codes = [];
  for (const source of ['process.exit(7)', 'process.exitCode = 6', "process.on('exit', () => { process.exitCode = 1; })"]) {
    const proc = await vm.spawn('node', ['-e', source]);
    proc.output.pipeTo(new WritableStream({ write() {} }));
    codes.push(await proc.exit);
  }
  window.codes = codes;
  return { port, url, codes };
};
</script>`;
const types = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html" };
const server = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, 'http://127.0.0.1:5600');
  if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  const rel = url.pathname === '/sw.js' ? 'assets/sw.js' : url.pathname.startsWith('/assets/') ? url.pathname.slice(1) : url.pathname.slice('/sdk/'.length);
  const file = new URL(rel, dist);
  if ((!url.pathname.startsWith('/sdk/') && !url.pathname.startsWith('/assets/') && url.pathname !== '/sw.js') || !file.href.startsWith(dist.href) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', types[path.extname(file.pathname)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
let browser;
const deadline = setTimeout(() => { console.error('Browser regression timed out'); process.exit(124); }, 590000);
try {
  await new Promise(resolve => server.listen(5600, '127.0.0.1', resolve));
  browser = await chromium.launch({ args: ['--mute-audio'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('requestfailed', request => console.error(request.url(), request.failure()));
  await page.goto('http://127.0.0.1:5600');
  const result = await page.evaluate(() => window.run());
  assert.deepEqual(result.codes, [7, 6, 1]);
  await page.waitForFunction(() => document.querySelector('#preview').contentDocument?.body.dataset.source === 'preview-folder-loaded');
  await page.waitForFunction(() => document.querySelector('#preview').contentDocument?.querySelector('iframe')?.contentDocument?.body.textContent.includes('Nested frame loaded'));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: new URL('preview.png', evidence).pathname });
  fs.writeFileSync(new URL('result.json', evidence), JSON.stringify({ ...result, sourceFolder: true, nestedFrame: true, errors }, null, 2));
  console.log('PASS: source folder preview, nested frame, and SDK exit codes', result);
  await page.evaluate(() => window.vm.teardown());
} finally {
  clearTimeout(deadline);
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
