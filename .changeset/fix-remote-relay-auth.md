---
'playwriter': patch
---

Fix MCP startup against token-protected remote relays, including Docker and devcontainer connections. The remote health check now sends the configured bearer token.

```bash
playwriter --host host.docker.internal --token MY_SECRET_TOKEN
```

Fixes #108
