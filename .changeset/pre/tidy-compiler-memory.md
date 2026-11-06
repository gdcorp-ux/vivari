---
"@vivari/core": patch
---

Default the in-process esbuild Go service to a 768 MiB soft memory limit to reduce its permanent Wasm high-water mark on large dependency scans. Explicit guest GOMEMLIMIT settings still take precedence.
