---
"alchemy-deploy": major
---

Redesign the root Marketplace action to own the complete single-job Alchemy deployment lifecycle. Consumers now invoke the action directly with an immutable release SHA while retaining workflow triggers, permissions, concurrency, and explicit secret mapping.
