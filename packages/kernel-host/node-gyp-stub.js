// node-gyp stub (package-managers North Star).
//
// Native (C/C++) addons can't be built in the browser sandbox: there is no
// compiler toolchain (python/make/gcc), and a `.node` binary couldn't be loaded
// anyway (we run wasm, not native). Real npm, however, runs a package's
// `install`/`rebuild` lifecycle script — which for native packages is
// `node-gyp rebuild` — and a NON-ZERO exit there aborts the whole `npm install`.
//
// To keep installs working we make node-gyp a non-fatal no-op: the build is
// skipped and the script "succeeds". This mirrors how browser WebContainers
// handle native deps — the package's JS fallback (or its wasm32-wasi build,
// auto-selected via optionalDependencies) is what actually loads at runtime.
//
// npm resolves the `node-gyp` command to a shell shim it puts on PATH
// (`.../node-gyp-bin/node-gyp`, which execs either its bundled node-gyp or
// `$npm_config_node_gyp`). Our runtime can't execute that POSIX shell shim (it
// compiles programs as JS), so instead we OVERWRITE the shim — and the bundled
// node-gyp entry — in the vendored npm tree with this JS stub. It carries a
// `#!/usr/bin/env node` line (the loader neutralizes shebangs) so it runs as a
// plain Node program regardless of the file's original extension.

export const NODE_GYP_STUB = `#!/usr/bin/env node
// Vivari node-gyp stub — see packages/kernel-host/node-gyp-stub.js.
const argv = process.argv.slice(2);
const verb = argv.find((a) => a && a[0] !== '-') || '';
// \`node-gyp --version\` is probed by some tooling; answer it plausibly.
if (argv.includes('-v') || argv.includes('--version')) {
  process.stdout.write('v11.0.0\\n');
  process.exit(0);
}
process.stderr.write(
  'node-gyp (Vivari stub): skipping native build' +
    (verb ? ' \\'' + verb + '\\'' : '') +
    ' — native addons are not supported in-browser; using the package\\'s JS/wasm fallback\\n',
);
process.exit(0);
`;

// The node-gyp entry points inside a vendored real-npm tree, relative to its
// root (e.g. /usr/lib/node_modules/npm). We overwrite whichever exist.
export const NODE_GYP_TARGETS = (npmRoot) => [
  // npm adds THIS dir to PATH when running lifecycle scripts (run-script/set-path).
  npmRoot + "/node_modules/@npmcli/run-script/lib/node-gyp-bin/node-gyp",
  // npm's own CLI shim dir (older layout / direct callers).
  npmRoot + "/bin/node-gyp-bin/node-gyp",
  // The bundled node-gyp the shim execs when $npm_config_node_gyp is unset.
  npmRoot + "/node_modules/node-gyp/bin/node-gyp.js",
];

// @npmcli/arborist's ideal-tree builder, relative to an npm root.
export const ARBORIST_BUILD_IDEAL_TREE =
  "/node_modules/@npmcli/arborist/lib/arborist/build-ideal-tree.js";

// Marker injected into #loadPeerSet once patched (used for idempotency and
// build-time verification).
export const ARBORIST_PEERSET_MARKER = "const peerSetParent = node.parent";

/**
 * Guard `@npmcli/arborist`'s `#loadPeerSet` against a peer node that gets
 * replaced in its virtual `peerSet` mid-iteration.
 *
 * How this happens on the live registry: `@angular/build` declares an optional
 * peer `vitest@^4.0.8`. Arborist still loads optional peers into a virtual
 * `peerSet` root (`node.parent`) to check for peer conflicts, resolving
 * `vitest@4.1.12`. While iterating `vitest@4.1.12`'s own peer edges,
 * `@vitest/browser-webdriverio@^4.1.11` resolves to `4.1.11` (the latest 4.x
 * published for that package), whose own `peerDependencies.vitest` is pinned
 * to `"4.1.11"`. The recursive `#loadPeerSet` sees that `4.1.11` also satisfies
 * `@angular/build`'s `^4.0.8` parentEdge and replaces `vitest@4.1.12` with
 * `vitest@4.1.11` in `peerSet` — detaching `vitest@4.1.12` (`node.parent = null`)
 * and finishing `#loadPeerSet` on the replacement. When control returns to the
 * outer loop and advances to the next peer edge (`@vitest/coverage-istanbul`),
 * `node.parent.edgesOut` throws `TypeError: Cannot read properties of null
 * (reading 'edgesOut')`.
 *
 * Once `node.parent` is null, the replacement in `peerSetParent` has already had
 * its own peer set loaded, so the outer loop's work is superseded and returning
 * the replacement node settles the call cleanly.
 *
 * Self-contained (no external free variables) so `ARBORIST_PEERSET_PRELOAD` can
 * embed `patchArboristPeerSet.toString()` directly.
 *
 * Returns the patched source string, or null if already patched or unrecognised.
 */
export function patchArboristPeerSet(source) {
  if (typeof source !== "string" || source.includes("const peerSetParent = node.parent")) {
    return null;
  }
  const lf = source.includes("\r\n") ? source.replace(/\r\n/g, "\n") : source;
  const head = "  async #loadPeerSet (node, required) {\n";
  const edge = "      const parentEdge = node.parent.edgesOut.get(edge.name)\n";
  const tail =
    "      // ok, it's the root, or we're in unforced strict mode, so this is bad\n" +
    "      this.#failPeerConflict(edge, parentEdge)\n" +
    "    }\n" +
    "    return node\n" +
    "  }";
  if (!lf.includes(head) || !lf.includes(edge) || !lf.includes(tail)) {
    try {
      console.warn(
        "[Vivari] @npmcli/arborist #loadPeerSet patch did NOT apply: " +
          "block shape changed (version drift). Update patchArboristPeerSet in " +
          "packages/kernel-host/node-gyp-stub.js.",
      );
    } catch {
      /* console may be unavailable in some worker contexts */
    }
    return null;
  }
  return lf
    .replace(head, head + "    const peerSetParent = node.parent\n")
    .replace(
      edge,
      "      if (!node.parent) {\n" +
        "        return peerSetParent.children.get(node.name) || node\n" +
        "      }\n" +
        edge,
    )
    .replace(
      tail,
      "      // ok, it's the root, or we're in unforced strict mode, so this is bad\n" +
        "      this.#failPeerConflict(edge, parentEdge)\n" +
        "    }\n" +
        "    return node.parent ? node : (peerSetParent.children.get(node.name) || node)\n" +
        "  }",
    );
}

/**
 * Self-contained CommonJS preload script that applies `patchArboristPeerSet`
 * when a host-spawned `npm` CLI loads `@npmcli/arborist`.
 */
export const ARBORIST_PEERSET_PRELOAD = `"use strict";
const fs = require("node:fs");
const patchArboristPeerSet = ${patchArboristPeerSet.toString()};
const origReadFileSync = fs.readFileSync;
fs.readFileSync = function readFileSync(p, ...args) {
  const res = origReadFileSync.call(this, p, ...args);
  if (typeof p === "string" && p.replace(/\\\\/g, "/").endsWith("${ARBORIST_BUILD_IDEAL_TREE}")) {
    const str = typeof res === "string" ? res : res.toString("utf8");
    const patched = patchArboristPeerSet(str);
    if (patched) return typeof res === "string" ? patched : Buffer.from(patched, "utf8");
  }
  return res;
};
`;

/**
 * Neutralize node-gyp inside a vendored real-npm tree so native builds become a
 * non-fatal no-op, and patch `@npmcli/arborist`'s `#loadPeerSet` detach crash.
 * Call after loading npm into the VFS, before running installs.
 *
 * @param kernel  a Kernel (uses its `exists`/`readFile`/`writeFile` VFS helpers)
 * @param npmRoot absolute VFS path to the npm package root
 * @returns the list of node-gyp paths that were stubbed
 */
export function stubNodeGyp(kernel, npmRoot) {
  const stubbed = [];
  for (const target of NODE_GYP_TARGETS(npmRoot)) {
    if (kernel.exists(target)) {
      kernel.writeFile(target, NODE_GYP_STUB);
      stubbed.push(target);
    }
  }
  const arboristTarget = npmRoot + ARBORIST_BUILD_IDEAL_TREE;
  if (kernel.exists(arboristTarget) && typeof kernel.readFile === "function") {
    const patched = patchArboristPeerSet(kernel.readFile(arboristTarget));
    if (patched) kernel.writeFile(arboristTarget, patched);
  }
  return stubbed;
}
