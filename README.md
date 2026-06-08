# 📡 GitDNS

> **DNS for GitHub repositories.**
> Maps every file path to a raw URL so AI agents can navigate vast codebases without ingesting a single line of code.

---

## The Problem

Large codebases are invisible to AI agents by default. To understand a repo, an agent today must either:

- **Ingest everything upfront** — expensive, hits context window limits fast
- **Crawl the GitHub API directory-by-directory** — slow, hits rate limits, requires recursive calls

## The Solution

GitDNS works like a DNS zone file. It doesn't contain the code — it tells the agent exactly where to find it.

One run. Two output files. Your agent navigates the entire codebase on demand.

```
google.com      →  DNS lookup  →  142.250.x.x       →  connect
src/Button.tsx  →  GitDNS      →  raw.githubusercontent.com/...  →  fetch
```

---

## Dual Output

```bash
$ node gitdns.js https://github.com/facebook/react

✅ Done!
   📄 facebook_react.txt          — human manifest  (rich, emojis, stats, both URLs)
   📡 gitdns.zone                 — gitdns zone file (lean, $ORIGIN + flat paths)
   Files : 3,421  |  Dirs: 412
```

### `owner_repo.txt` — Human Manifest
For developers orienting in a new codebase. Full directory tree with icons, file sizes, tech stack detection, and both stable + latest raw URLs per file.

### `gitdns.zone` — Machine Zone File
For AI agents. Token-optimized. Uses DNS `$ORIGIN` to declare the base URL once — eliminating repetition across thousands of file entries.

```
; GitDNS Authoritative Zone File
; Repo   : facebook/react | Branch: main
; Files  : 3421
; Generated: 08 Jun 2026, 09:03 am IST

$ORIGIN https://raw.githubusercontent.com/facebook/react/main/

.gitignore
LICENSE
README.md
packages/react/index.js
packages/react/src/React.js
packages/react-dom/index.js
...3415 more lines
```

Agent prompt to pair with this file:

```
You have been given a gitdns.zone file for this repository.
Read the $ORIGIN value at the top to establish the base URL.
When you need to inspect a file, combine $ORIGIN + relative path
and use your fetch tool to retrieve it on demand.
Do not attempt to read all files upfront.
```

---

## Quick Start

**No install needed.** Requires only Node.js (built-in modules, zero dependencies).

```bash
# Clone
git clone https://github.com/JOLT-dailyAi/GitDNS
cd GitDNS

# Run against any public repo
node gitdns.js https://github.com/facebook/react

# Specify a branch
node gitdns.js https://github.com/facebook/react main

# Custom zone filename (useful for multiple repos)
node gitdns.js https://github.com/org/auth-service --output auth-service
node gitdns.js https://github.com/org/payments     --output payments
# produces: auth-service.zone and payments.zone
```

---

## Authentication

GitDNS uses **your** GitHub token to call the GitHub API. Your token, your rate limits, your account — the tool author is never involved in your API calls.

| Scenario | Token needed? | Rate limit |
|---|---|---|
| Public repo | Optional | 60 req/hour without, 5,000 with |
| Private repo | Required | 5,000 req/hour |

```bash
# Set your token (recommended even for public repos)
export GITHUB_TOKEN=ghp_yourtoken        # Linux / Mac
set GITHUB_TOKEN=ghp_yourtoken           # Windows cmd

node gitdns.js https://github.com/owner/repo
```

Your token is read from the environment variable — it is never passed as a command-line argument and never logged.

---

## GitHub Actions — Auto-generate on every push

Add this to your repo at `.github/workflows/gitdns.yml` to regenerate the zone file automatically whenever files are added or deleted.

```yaml
name: GitDNS — Update zone file

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Clone GitDNS
        run: git clone https://github.com/JOLT-dailyAi/GitDNS /tmp/gitdns

      - name: Generate zone file
        run: node /tmp/gitdns/gitdns.js https://github.com/${{ github.repository }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Commit zone file
        run: |
          git config user.name  "gitdns-bot"
          git config user.email "gitdns@users.noreply.github.com"
          git add gitdns.zone *_*.txt
          git diff --staged --quiet || git commit -m "chore(ai): update gitdns zone file [skip ci]"
          git push
```

This runs on GitHub's free runners (ubuntu-latest, 16GB RAM) — zero cost for public repos, uses your repo's built-in `GITHUB_TOKEN` automatically.

---

## Free Tier Limits

| Limit | Free tier | Why |
|---|---|---|
| Repo visibility | Public only | — |
| Max files | 5,000 | — |
| Max depth | 5 levels | — |

Repos exceeding these limits exit with a clear failure message explaining what changed and how to fix it — so scheduled runs don't silently pass when a repo grows past a limit.

---

## Why Not Just Use Repomix / Gitingest?

| | Repomix / Gitingest | GitDNS |
|---|---|---|
| Dumps full file contents | ✅ | ❌ intentional |
| Token cost | Very high | Minimal |
| Works on large monorepos | Hits context limits | ✅ |
| Agent fetches only what it needs | ❌ | ✅ |
| Portable flat file | ✅ | ✅ |
| Zero dependencies | ❌ | ✅ |

GitDNS is not a code dumper. It is a navigation index. The agent reads the map, then fetches only the files it actually needs.

---

## Roadmap

- [ ] GitHub Action published to Marketplace
- [ ] GitHub Sponsors — support the project
- [ ] Private repo support (paid tier)
- [ ] Hosted web version — paste a URL, get the files
- [ ] Archive of popular public repo zone files

---

## License

MIT — free to use, modify, and build on.

---

<p align="center">
  Built by <a href="https://github.com/JOLT-dailyAi">JOLT-dailyAi</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/JOLT-dailyAi/GitDNS/issues">Report an issue</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/sponsors/JOLT-dailyAi">Support this project</a>
</p>
