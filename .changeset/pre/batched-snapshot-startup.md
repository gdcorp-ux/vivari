---
"@vivari/core": patch
---

Create mounted directories in the filesystem worker's existing batch operation,
including empty directories, rather than one synchronous kernel call per folder.
Add `BootOptions.persist` (default true): embedders that restore their own complete
saved tree can skip the redundant OPFS project mirror without deleting it or
disabling the independent dependency cache.
