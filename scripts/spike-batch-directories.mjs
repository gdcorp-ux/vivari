// Exercise the real kernel-to-filesystem batch path, including directory-only
// imports. No network or browser; a deadline bounds regressions in the bridge.
import assert from 'node:assert/strict';
import { bootSpikeKernel } from './lib/spike-harness.mjs';
const deadline = setTimeout(() => process.exit(124), 30000);
const h = await bootSpikeKernel();
try {
  const dirs = Array.from({ length: 10720 }, (_, i) => '/batch/d' + i + '/empty');
  const began = performance.now();
  await h.kernel.writeFilesBatch([], dirs);
  assert.equal(h.kernelFs.fs.stat('/batch/d10719/empty').kind, 'dir');
  assert.deepEqual(h.kernel.readdir('/batch/d500/empty'), []);
  await h.kernel.writeFilesBatch([{ path: '/batch/d500/value', bytes: 'kept' }], ['/batch/other/empty']);
  assert.equal(h.kernel.readFile('/batch/d500/value'), 'kept');
  assert.deepEqual(h.kernel.readdir('/batch/other/empty'), []);
  console.log('10,720 empty directories created in one batch: ' + Math.round(performance.now() - began) + 'ms');
  await assert.rejects(h.kernel.writeFilesBatch([], ['/batch/d500/value/child']));
} finally {
  await h.fsWorker.terminate(); clearTimeout(deadline);
}
