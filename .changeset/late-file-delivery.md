---
"@vivari/core": patch
---

Let an embedder start an app on part of a large tree. `vv-fs-expect` promises files a later mount will deliver: a process request that touches one waits for it (announced as `vv-fs-hold`) instead of seeing ENOENT or a short directory listing, while unpromised paths still answer at once. `vv-fs-trace` records the paths requested while on, so an embedder can learn which files startup needs. Fork build `1.1.3-gdux.3`.
