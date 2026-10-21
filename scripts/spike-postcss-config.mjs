// NETWORK provisioning, then real Vite 6 over the shipped kernel/runtime.
// node scripts/run-spikes.mjs --net postcss-config
// Or pass an installed public fixture directory as argv[2]. No browser needed.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { bootSpikeKernel, writeProject, defaultEnv } from "./lib/spike-harness.mjs";

const host = process.argv[2] || "/tmp/vv-postcss-config";
const h = await bootSpikeKernel();
const dir = "/postcss-fixture";
const deadline = setTimeout(() => { console.error("PostCSS fixture timed out"); process.exit(124); }, 120000);
function copyTree(from, to) {
  h.kernel.mkdirp(to);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === ".bin") continue;
    const src = path.join(from, entry.name), dst = to + "/" + entry.name;
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) h.kernel.writeFile(dst, fs.readFileSync(src));
  }
}
copyTree(path.join(host, "node_modules"), dir + "/node_modules");
const plugin = `({ postcssPlugin: 'fixture-color', Declaration(decl) { if (decl.value === 'fixture-color') decl.value = 'rgb(1, 2, 3)'; } })`;
try {
  for (const [ext, config] of [
    ["mjs", `export default { plugins: [(await import('./plugin.cjs')).default] };`],
    ["js", `export default { plugins: [(await import('./plugin.cjs')).default] };`],
    ["cjs", `module.exports = { plugins: [${plugin}] };`],
  ]) {
    const root = dir + "/" + ext;
    writeProject(h.kernel, root, {
      "package.json": '{"type":"module"}',
      [`postcss.config.${ext}`]: config,
      "plugin.cjs": `module.exports = ${plugin};`,
      "src/style.css": ".fixture { color: fixture-color; }",
      "run.mjs": `import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), configFile: false, server: { middlewareMode: true, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const result = await server.transformRequest('/src/style.css');
  console.log('TRANSFORM:' + result.code);
} finally { await server.close(); }
`,
    });
    const result = await h.kernel.start("node", ["run.mjs"], { cwd: root, env: defaultEnv(root), capture: true });
    console.log(`${ext}: exit=${result.code}\n${result.stdout || ""}\n${result.stderr || ""}`);
    assert.equal(result.code, 0, `${ext} Vite transform exits successfully`);
    assert.match(result.stdout, /rgb\(1, 2, 3\)/, `${ext} project config transforms CSS`);
    assert.doesNotMatch(result.stdout, /color: fixture-color/, `${ext} CSS is not left untouched`);
  }
  console.log("PASS: Vite honors project PostCSS configs (.mjs, .js, .cjs)");
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
} finally { clearTimeout(deadline); }
