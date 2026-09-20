---
"alchemy-deploy": minor
---

Add a scheduled preview reconcile that destroys preview stages whose pull request is no longer open, so a missed `pull_request: closed` event cannot leave a preview Worker serving after its pull request closed.
