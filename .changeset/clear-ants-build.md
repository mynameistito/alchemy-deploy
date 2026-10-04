---
"alchemy-deploy": patch
---

Use Node 24-compatible artifact actions for PR previews: `actions/download-artifact` v8 in the action and `actions/upload-artifact` v7 in the consumer example. They require Actions runner v2.327.1 or newer; GitHub-hosted runners already meet this requirement.
