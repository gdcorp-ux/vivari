---
"@vivari/core": patch
---

Remove incomplete copyFile destinations after failures while preserving the
original error and protecting the source. Reject forced reflinks with ENOSYS
when cloning is unavailable; optional reflinks still fall back to byte copies.
