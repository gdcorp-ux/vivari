// Spike (OFFLINE): a process that touches a file the embedder has promised but
// not yet delivered waits for it, instead of seeing ENOENT or a short listing.
//
// WHY THIS EXISTS. An embedder with a large tree (the Playground's full-build
// snapshots) mounts what startup needs first, starts the app, and delivers the
// rest in background batches. Before that rest arrives, a lazy import or a new
// route can ask for a file that isn't there yet. `vv-fs-expect` lists those files;
// FsServer parks any process request on one until a batch write delivers it, and
// announces each wait (`fs-hold`) so the embedder can send that batch first. Paths
// that were never promised still fail at once, so module-resolution probes and
// existsSync checks are not slowed. `vv-fs-trace` records the paths requested
// while on, which is how the embedder learns what startup needs.
//
//   run:  node scripts/spike-fs-expect.mjs

import { bootSpikeKernel, writeProject } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

const h = await bootSpikeKernel();
const { kernel, kernelFs, fsWorker } = h;
const holds = [];
let seq = 1e6;
const replies = new Map();
fsWorker.on("message", (m) => {
  if (m.type === "fs-hold") holds.push(m.path);
  if ((m.type === "fs-call-ok" || m.type === "fs-call-err") && replies.has(m.id)) replies.get(m.id)(m);
});
const call = (type, extra) => new Promise((resolve, reject) => {
  const id = seq++;
  replies.set(id, (m) => (m.type === "fs-call-ok" ? resolve(m.result) : reject(new Error(m.error))));
  fsWorker.postMessage({ type, id, ...extra });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (fn()) return true;
  return false;
};
const text = (s) => new TextEncoder().encode(s);

const GUEST = String.raw`
const fs = require('fs');
console.log('absent ' + fs.existsSync('/app/node_modules/nope.js'));
console.log('probe ' + (() => { try { fs.statSync('/app/node_modules/late/nope.js'); return 'found'; } catch (e) { return e.code; } })());
console.log('listing ' + fs.readdirSync('/app/node_modules/late').sort().join(','));
console.log('via-link ' + fs.readFileSync('/app/node_modules/alias/index.js', 'utf8').includes('module.exports'));
console.log('required ' + require('late'));
`;
writeProject(kernel, "/app", { "index.js": GUEST });
kernel.mkdirp("/app/node_modules/late");
kernelFs.fs.symlink("late", "/app/node_modules/alias");

await call("fs-trace", { on: true });
const count = await call("fs-expect", { paths: ["/app/node_modules/late/package.json", "/app/node_modules/late/index.js"] });
ok(count === 2, "two files promised");
const began = Date.now();
let exited = false;
const run = kernel.start("node", ["index.js"], { cwd: "/app", capture: true }).finally(() => { exited = true; });

ok(await until(() => holds.includes("/app/node_modules/late")), "the listing waits on the incomplete directory");
await sleep(300);
ok(!exited, "the process is still parked, not failed");
await kernelFs.fs.writeFilesBatch([{ path: "/app/node_modules/late/package.json", bytes: text('{"name":"late","main":"index.js"}') }]);
await sleep(300);
ok(!exited, "half the promised files do not release the listing");
await kernelFs.fs.writeFilesBatch([{ path: "/app/node_modules/late/index.js", bytes: text("module.exports = 'late value';") }]);
const r = await run;
const out = r.stdout || "";
ok(/absent false/.test(out), "an existsSync of an unpromised path answers at once");
ok(/probe ENOENT/.test(out), "a probe for an unpromised file in a waiting directory fails at once");
ok(/listing index\.js,package\.json/.test(out), "the listing is complete once both files land");
ok(/via-link true/.test(out), "a read through a symlink sees the delivered target");
ok(/required late value/.test(out), "require() of the late package works");
ok(r.code === 0, `exit 0 (took ${Date.now() - began} ms)`);
if (r.code !== 0) console.log(r.stderr);

const traced = await call("fs-trace", { on: false });
ok(traced.includes("/app/node_modules/late/index.js") && traced.includes("/app/index.js"), `the trace lists requested paths (${traced.length})`);
ok(traced.includes("/app/node_modules/late/"), "a listed directory is traced with a trailing slash");

// A file that already exists is not waited for (its batch landed first).
ok(await call("fs-expect", { paths: ["/app/node_modules/late/index.js"] }) === 0, "promising a present file is a no-op");

// A read through a symlink waits too, and a promise that is dropped releases
// its waiter with the real answer.
holds.length = 0;
await call("fs-expect", { paths: ["/app/node_modules/late/ghost.js"] });
writeProject(kernel, "/app", { "ghost.js": "try { require('fs').readFileSync('/app/node_modules/alias/ghost.js'); console.log('ghost found'); } catch (e) { console.log('ghost ' + e.code); }" });
const ghost = kernel.start("node", ["ghost.js"], { cwd: "/app", capture: true });
ok(await until(() => holds.includes("/app/node_modules/alias/ghost.js")), "a read of a promised file through a symlink waits");
await call("fs-expect", { paths: [], clear: true });
ok(/ghost ENOENT/.test((await ghost).stdout || ""), "clearing the promise releases it with ENOENT");

// The kernel's own requests are never held: it is what delivers the batches.
await call("fs-expect", { paths: ["/app/node_modules/kernel.js"] });
ok(!kernel.exists("/app/node_modules/kernel.js"), "the kernel's own lookups answer at once");
await call("fs-expect", { paths: [], clear: true });

console.log(failed ? `\n${failed} check(s) failed` : "\nfs-expect: all checks passed");
process.exit(failed ? 1 : 0);
