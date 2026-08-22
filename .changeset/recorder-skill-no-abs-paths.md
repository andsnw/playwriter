---
'playwriter': patch
---

Stop putting machine-specific absolute paths in recorded skills. The recorder prompt now tells agents to import the helper script with a path relative to the playwriter cwd, or with `join(homedir(), '.agents/skills/<name>/submit.js')`, so the skill works on any computer.

```bash
playwriter -s 1 -e 'const { submitProduct } = await import("./.agents/skills/submit-to-directory/submit.js"); await submitProduct({ page, name, url })'
```
