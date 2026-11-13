---
"@vivari/core": patch
---

Copy large files in bounded descriptor chunks so copyFileSync, callback/promise
copies and recursive cpSync can copy files larger than the shared bridge window.
Handle short writes, close descriptors on failure, preserve source permissions,
and protect same-file aliases before overwriting.
