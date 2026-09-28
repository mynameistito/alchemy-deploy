---
"alchemy-deploy": major
---

Deploy PR Worker Previews from credential-free CI artifacts using Alchemy 2.0.0-beta.79 and first-class `preview.of` resources. PR-controlled build output is no longer executed by the privileged deployment job. Consumers must upload a complete Worker bundle from CI and configure its artifact name and entrypoint.
