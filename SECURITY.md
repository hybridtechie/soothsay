# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.x (latest release) | Yes |
| Anything older | No |

While soothsay is pre-1.0, only the latest published 0.x release receives security fixes. Upgrade to the newest version before reporting.

## Reporting a vulnerability

Please report vulnerabilities **privately** via GitHub Security Advisories:

1. Go to <https://github.com/hybridtechie/soothsay/security/advisories/new>
2. Describe the issue, affected version, and reproduction steps.

Do **not** open a public issue for security problems. You should receive an acknowledgement within a few days; fixes for confirmed issues will be released as a patch version and credited to the reporter unless anonymity is requested.

## Security model

Understanding what soothsay does (and does not do) with your repository:

- **Soothsay executes NO documented commands.** It parses the commands your docs mention and stat-checks them against repo facts (package.json scripts, files on disk). A doc saying `npm run deploy` is never run — soothsay only checks that a `deploy` script exists.
- **The only subprocess calls are `git log` and `git check-ignore`**, used for freshness tracking and gitignore filtering. No other processes are spawned.
- **No network access in the deterministic core.** Layers 0–2 read only the local filesystem and git metadata.
- **The `--ai` flag is opt-in and sends doc content to the Anthropic API.** It runs only when you pass `--ai` and set `ANTHROPIC_API_KEY`. Scanned doc content (your agent markdown) is transmitted to Anthropic for the advisory pass; nothing else is uploaded. If your docs contain secrets (they shouldn't), do not use `--ai`.
