// Offline copyFile gate: real VM/SAB/VFS, plus injected short I/O and failures
// that a healthy in-memory VFS cannot produce. Run: npm run spikes -- fs-copyfile
import assert from "node:assert/strict";
import { createFsBinding } from "../packages/runtime/node/bindings/fs.js";
import { bootSpikeKernel, writeProject } from "./lib/spike-harness.mjs";

const hardStop = setTimeout(() => process.exit(124), 60_000);

// Force short reads AND writes, and forbid whole-file transfers. Track every
// descriptor so success, failed opens, reads, writes and closes prove cleanup.
function exercise(failure, { existing = false, sameFile = false, cleanupFailure = false, mode = 0 } = {}) {
  const bytes = Uint8Array.from({ length: 29 }, (_, i) => i * 7);
  const copied = [];
  const closed = [];
  const unlinked = [];
  let destinationExists = existing;
  let truncated = false;
  let readOffset = 0;
  const destination = sameFile === "path" ? "/src" : "/dest";
  // Already-labelled errors retain identity, proving cleanup cannot replace
  // the actual copy failure with its own close/unlink error.
  const original = Object.assign(new Error("injected copy failure"), { code: "EIO", syscall: "copyfile" });
  const cleanup = Object.assign(new Error("injected cleanup failure"), { code: "ENOSPC" });
  const boom = () => { throw original; };
  const binding = createFsBinding({ process: { cwd: () => "/", nextTick: queueMicrotask }, sys: {
    open(path, flags) {
      if (flags === 0) return 0;
      assert.equal(path, destination);
      if (failure === "open") boom();
      if (destinationExists && (flags & 0o200)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      assert.ok(destinationExists || (flags & 0o100), "creation requires O_CREAT");
      destinationExists = true;
      return 1;
    },
    fstat(fd) {
      if (fd === 1 && failure === "stat") boom();
      return { kind: "file", ino: sameFile ? 1 : fd + 1, mode: 0o751 };
    },
    ftruncate() { assert.equal(!!sameFile, false, "never truncate the source"); if (failure === "truncate") boom(); truncated = true; },
    fchmod() { if (failure === "chmod") boom(); },
    fdRead(fd, length) {
      assert.ok(length <= 512 * 1024);
      if (failure === "read" && readOffset > 0) boom();
      const chunk = bytes.slice(readOffset, readOffset + Math.min(length, 7));
      readOffset += chunk.length;
      return chunk;
    },
    fdWrite(fd, chunk) {
      assert.ok(chunk.length <= 512 * 1024);
      if (failure === "write" && copied.length > 0) boom();
      if (failure === "zero-write") return 0;
      copied.push(...chunk.subarray(0, 3));
      return Math.min(3, chunk.length);
    },
    close(fd) {
      closed.push(fd);
      if (failure === "close" && fd === 1) boom();
      if (cleanupFailure) throw cleanup;
    },
    unlink(path) {
      assert.deepEqual(closed, [1, 0], "close both descriptors before unlinking");
      unlinked.push(path);
      if (cleanupFailure) throw cleanup;
      destinationExists = false;
    },
    readFile() { assert.fail("whole-file read"); },
    writeFile() { assert.fail("whole-file write"); },
  } });
  if (failure) assert.throws(() => binding.copyFile("/src", destination, mode), e =>
    failure === "zero-write" ? e.code === "EIO" && e.syscall === "copyfile" : e === original);
  else {
    binding.copyFile("/src", destination, mode);
    assert.deepEqual(copied, sameFile ? [] : [...bytes]);
  }
  assert.deepEqual(closed, failure === "open" ? [0] : [1, 0]);
  const removeDestination = !!failure && failure !== "open" && (!existing || truncated);
  assert.deepEqual(unlinked, removeDestination ? ["/dest"] : []);
  assert.equal(destinationExists, removeDestination && !cleanupFailure ? false : existing || failure !== "open");
}
for (const existing of [false, true]) {
  for (const failure of [undefined, "open", "stat", "truncate", "chmod", "read", "write", "zero-write", "close"])
    exercise(failure, { existing });
  for (const failure of ["chmod", "read", "write", "zero-write"])
    exercise(failure, { existing, cleanupFailure: true });
}
for (const sameFile of ["path", "alias"])
  for (const failure of [undefined, "stat", "close"])
    exercise(failure, { existing: true, sameFile });
exercise(undefined, { mode: 2 /* COPYFILE_FICLONE: byte-copy fallback */ });
console.log("  ✓ bounded short I/O, failed-copy unlink, original errors, descriptor cleanup and source protection");

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
  for (const [name, copy] of Object.entries(copies)) {
    const src = '/copy/src/nested/1048577';
    const bytes = fs.readFileSync(src);
    const dest = '/copy/' + name + '-clone';
    await copy(src, dest, fs.constants.COPYFILE_FICLONE);
    assert.deepEqual(fs.readFileSync(dest), bytes);
    const prior = Buffer.from('keep destination on unsupported clone');
    fs.writeFileSync(dest, prior);
    for (const flags of [fs.constants.COPYFILE_FICLONE_FORCE,
      fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_FICLONE_FORCE]) {
      await assert.rejects(async () => copy(src, dest, flags), {code:'ENOSYS',syscall:'copyfile',path:src,dest});
      assert.deepEqual(fs.readFileSync(dest), prior);
      await assert.rejects(async () => copy(src, dest + '-new', flags), {code:'ENOSYS'});
      assert.equal(fs.existsSync(dest + '-new'), false);
      await assert.rejects(async () => copy(src, src, flags), {code:'ENOSYS'});
      assert.deepEqual(fs.readFileSync(src), bytes);
    }
    console.log('PASS clone ' + name);
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
  assert.equal((result.stdout.match(/^PASS /gm) || []).length, 16, result.stdout + result.stderr);
  console.log(result.stdout.trim());
  console.log("  ✓ sync/callback/promises: empty and large binary copies, overwrite, mode, EXCL, errors, aliases, clone flags and recursive cp");
  clearTimeout(hardStop);
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
