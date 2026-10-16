---
"@vivari/core": patch
---

Guard `@npmcli/arborist`'s `#loadPeerSet` against a peer node that gets replaced and detached in its virtual `peerSet` mid-iteration (triggered by `@angular/build` → `vitest@4.1.12` → `@vitest/browser-webdriverio@4.1.11`), preventing `TypeError: Cannot read properties of null (reading 'edgesOut')` during `npm install`.
