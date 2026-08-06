---
'playwriter': patch
---

Fix cross-OS CLI/relay session cwd resolution (Windows CLI + WSL relay).

When the CLI runs on Windows and the relay on Linux (common with WSL2 localhost forwarding), Windows paths like `C:\Users\me\project` were naively resolved with POSIX `path.resolve()`, producing mangled paths like `/home/me/C:\Users\me\project`. All sandbox fs operations then failed with ENOENT.

Now the relay detects Windows paths and automatically translates them to WSL mount paths (`/mnt/c/Users/me/project`). If the WSL mount doesn't exist, the session falls back to `/tmp` only with a clear warning instead of silently breaking.

Also includes allowed directories in ScopedFS EPERM error messages for easier debugging.

Fixes #107
