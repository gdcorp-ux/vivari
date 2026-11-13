// Offline copyFile gate: real VM/SAB/VFS, plus injected short I/O and failures
// that a healthy in-memory VFS cannot produce. Run: npm run spikes -- fs-copyfile
import assert from "node:assert/strict";
import { createFsBinding } from "../packages/runtime/node/bindings/fs.js";
import { bootSpikeKernel, writeProject } from "./lib/spike-harness.mjs";

const hardStop = setTimeout(() => process.exit(124), 60_000);

// Force short reads AND writes, and forbid whole-file transfers. Track every
// descriptor so success, failed opens, reads, writes and closes prove cleanup.
function exercise(failure) {
  const bytes = Uint8Array.from({ length: 29 }, (_, i) => i * 7);
  const copied = [];
  const closed = [];
  let readOffset = 0;
  const boom = () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); };
  const binding = createFsBinding({ process: { cwd: () => "/", nextTick: queueMicrotask }, sys: {
    open(path) { if (path === "/dest" && failure === "open") boom(); return path === "/src" ? 0 : 1; },
    fstat(fd) { return { kind: "file", ino: fd + 1, mode: 0o751 }; },
    ftruncate() {}, fchmod() {},
    fdRead(fd, length) {
      assert.ok(length <= 512 * 1024);
      if (failure === "read") boom();
      const chunk = bytes.slice(readOffset, readOffset + Math.min(length, 7));
      readOffset += chunk.length;
      return chunk;
    },
    fdWrite(fd, chunk) {
      assert.ok(chunk.length <= 512 * 1024);
      if (failure === "write") boom();
      if (failure === "zero-write") return 0;
      copied.push(...chunk.subarray(0, 3));
      return Math.min(3, chunk.length);
    },
    close(fd) { closed.push(fd); if (failure === "close" && fd === 1) boom(); },
    readFile() { assert.fail("whole-file read"); },
    writeFile() { assert.fail("whole-file write"); },
  } });
  if (failure) assert.throws(() => binding.copyFile("/src", "/dest", 0), { code: "EIO" });
  else { binding.copyFile("/src", "/dest", 0); assert.deepEqual(copied, [...bytes]); }
  assert.deepEqual(closed, failure === "open" ? [0] : [1, 0]);
}
for (const failure of [undefined, "open", "read", "write", "zero-write", "close"]) exercise(failure);
console.log("  ✓ bounded short I/O, zero-progress failure, and descriptor cleanup");

const GUEST = String.raw`
const fs = require('fs');
const fsp = require('fs/promises');
const assert = require('assert/strict');
(async () => {
  fs.mkdirSync('/copy/src/nested', {recursive:true});
  const copies = {
    sync: (src, dest, flags) => fs.copyFileSync(src, dest, flags),
    callback: (src, dest, flags) => new Promise((resolve, reject) =>
      fs.copyFile(src, dest, flags, e => e ? reject(e) : resolve())),
    promises: (src, dest, flags) => fsp.copyFile(src, dest, flags),
  };
  for (const size of [0, 1024 * 1024, 1024 * 1024 + 1, 6 * 1024 * 1024 + 17]) {
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >>> 16)) & 255;
    const src = '/copy/src/nested/' + size;
    fs.writeFileSync(src, bytes);
    fs.chmodSync(src, 0o751);
    for (const [name, copy] of Object.entries(copies)) {
      const dest = '/copy/' + name;
      fs.writeFileSync(dest, Buffer.alloc(size + 33, 99));
      fs.chmodSync(dest, 0o600);
      await copy(src, dest, 0);
      assert.deepEqual(fs.readFileSync(dest), bytes);
      assert.equal(fs.statSync(dest).mode & 0o777, 0o751);
      await copy(src, dest + '-new', 0);
      assert.deepEqual(fs.readFileSync(dest + '-new'), bytes);
      assert.equal(fs.statSync(dest + '-new').mode & 0o777, 0o751);
      fs.unlinkSync(dest + '-new');
      await assert.rejects(async () => copy(src, dest, fs.constants.COPYFILE_EXCL), {code:'EEXIST'});
      assert.deepEqual(fs.readFileSync(dest), bytes);
      await assert.rejects(async () => copy('/copy/missing', dest, 0), {code:'ENOENT',syscall:'copyfile',path:'/copy/missing',dest});
      assert.deepEqual(fs.readFileSync(dest), bytes);
      await assert.rejects(async () => copy('/copy/missing', dest + '-missing', 0), {code:'ENOENT'});
      assert.equal(fs.existsSync(dest + '-missing'), false);
      await assert.rejects(async () => copy('/copy/src', dest, 0), {code:'EISDIR'});
      assert.deepEqual(fs.readFileSync(dest), bytes);
      await assert.rejects(async () => copy(src, '/copy/src', 0), {code:'EISDIR'});
      await copy(src, src, 0);
      assert.deepEqual(fs.readFileSync(src), bytes);
      await assert.rejects(async () => copy(src, src, fs.constants.COPYFILE_EXCL), {code:'EEXIST'});
      fs.linkSync(src, '/copy/hardlink');
      fs.symlinkSync(src, '/copy/symlink');
      await copy(src, '/copy/hardlink', 0);
      await copy(src, '/copy/symlink', 0);
      assert.deepEqual(fs.readFileSync(src), bytes);
      fs.unlinkSync('/copy/hardlink'); fs.unlinkSync('/copy/symlink');
      console.log('PASS ' + name + ' ' + size);
    }
  }
  fs.cpSync('/copy/src', '/copy/tree', {recursive:true});
  for (const name of fs.readdirSync('/copy/src/nested'))
    assert.deepEqual(fs.readFileSync('/copy/tree/nested/' + name), fs.readFileSync('/copy/src/nested/' + name));
  console.log('PASS recursive');
})().catch(e => {console.error(e.stack); process.exitCode=1;});
`;

try {
  const h = await bootSpikeKernel();
  writeProject(h.kernel, "/copy-test", { "guest.cjs": GUEST });
  const result = await h.kernel.start("node", ["/copy-test/guest.cjs"], { cwd: "/copy-test", capture: true });
  assert.equal(result.code, 0, result.stderr);
  assert.equal((result.stdout.match(/^PASS /gm) || []).length, 13, result.stdout + result.stderr);
  console.log(result.stdout.trim());
  console.log("  ✓ sync/callback/promises: empty and large binary copies, overwrite, mode, EXCL, errors, aliases and recursive cp");
  clearTimeout(hardStop);
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
