---
"alchemy-deploy": major
---

Update the trusted deployment runtime to Alchemy 2.0.0-beta.85 and Effect 4.1.2 to support v8 state stores. Consumers sharing a state store must upgrade their Alchemy clients to beta.85 or newer before using this release; older clients cannot read the v8 store. Existing action inputs and resource definitions are unchanged.
