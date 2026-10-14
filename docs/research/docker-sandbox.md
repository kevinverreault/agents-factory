# Sandboxing Claude Code runs in Docker

Research for issue #7 (map #1, "Agent factory v1"). Question: how can Claude Code runs at the highest autonomy level (L2: skip permission prompts, push branches, open draft PRs) be sandboxed in Docker on Windows (Docker Desktop / WSL2) and later on Mac?

Researched 2026-10-14. Sources are first-party docs and source code. Version facts come from those pages on that date. Anything not confirmed by a primary source is marked **UNVERIFIED**.

## Answer in brief

1. **Two viable backends exist, so the factory should hide them behind one sandbox seam.**
   - **Docker Sandboxes (`sbx`)** is Docker's product for coding agents. Each sandbox is a microVM with its own Docker daemon. A host-side proxy enforces a deny-by-default egress policy and injects credentials so the real keys never enter the VM. Its clone mode hands work back to the host as a `sandbox-<name>` git remote. It is the better sandbox, but local sandboxes need **Windows 11** (or macOS 14+ on Apple silicon). The operator's machine today is Windows 10 Pro 22H2 (build 19045), so `sbx` cannot run there.
   - **A plain Docker container modelled on Anthropic's reference devcontainer** runs on Docker Desktop (WSL2 backend), including Windows 10 22H2 and Mac. It uses a non-root user, a default-deny iptables firewall, and `--dangerously-skip-permissions`. The factory owns credential injection, egress and the git hand-off itself.
2. **Recommendation for v1:** build the plain-container backend first, because it runs on the operator's current machine and on Mac. Shape the seam to match `sbx` concepts (clone mode, branch hand-off, secrets by service, network policy), so an `sbx` backend can replace it once the host is on Windows 11 or macOS on Apple silicon. If the operator upgrades to Windows 11 before building, start with `sbx` instead.
3. **Filesystem:** do **not** bind-mount the host git worktree into the container. Clone inside the container (a container filesystem or named volume), either from GitHub or from a read-only mount of the host repo. The agent pushes its branch; the factory fetches it. This avoids broken `.git` pointer files, slow Windows-to-Linux file I/O, and missing inotify events.
4. **Claude credentials:** for the subscription, mint a one-year token with `claude setup-token` on the host and pass it as `CLAUDE_CODE_OAUTH_TOKEN`. For API billing, pass `ANTHROPIC_API_KEY`. Never mount the host `~/.claude`. In a plain container the token is readable by the agent; only `sbx` keeps it out of the sandbox.
5. **Egress:** default-deny, allowing only `api.anthropic.com`, GitHub, and the package registries the task needs. Either use iptables in the container (the reference approach) or put the container on an `--internal` Docker network whose only way out is an allowlisting HTTPS proxy.
6. **git / gh:** give each run a short-lived, repo-scoped GitHub token: a GitHub App installation token (expires after 1 hour) or a fine-grained PAT limited to one repo. Set it as `GH_TOKEN` and run `gh auth setup-git` so `git push` over HTTPS uses it. Under `sbx`, `sbx secret set github --command 'gh auth token'` injects it through the proxy instead.

## 1. Anthropic's reference devcontainer and firewall

Sources:
- Docs: https://code.claude.com/docs/en/devcontainer (the old `docs.claude.com/en/docs/claude-code/devcontainer` URL now 301-redirects here).
- Reference files: https://github.com/anthropics/claude-code/tree/main/.devcontainer. The last commit touching `.devcontainer/` is `d945a61` (2026-06-30).
- Comparison page: https://code.claude.com/docs/en/sandbox-environments

What the reference contains:
- **`Dockerfile`**: `FROM node:20`. It installs `git`, `gh`, `iptables`, `ipset`, `iproute2`, `dnsutils`, `aggregate` and `jq`, then `npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}` (default `latest`). It runs as the non-root `node` user. A sudoers entry lets `node` run only `/usr/local/bin/init-firewall.sh` as root.
- **`devcontainer.json`**:
  - `runArgs: ["--cap-add=NET_ADMIN", "--cap-add=NET_RAW"]` (needed for iptables).
  - `remoteUser: "node"`.
  - Named volumes `claude-code-config-${devcontainerId}` at `/home/node/.claude` and a bash-history volume.
  - `CLAUDE_CONFIG_DIR=/home/node/.claude`.
  - Workspace bind-mounted at `/workspace` (`consistency=delegated`).
  - `postStartCommand: sudo /usr/local/bin/init-firewall.sh`.
- **`init-firewall.sh`**:
  - Flushes iptables but keeps Docker's embedded DNS (127.0.0.11) NAT rules.
  - Allows outbound DNS (udp/53), outbound SSH (tcp/22) and loopback.
  - Builds an `ipset` from GitHub's `web`/`api`/`git` CIDRs (fetched from `https://api.github.com/meta`) plus the resolved A records of `registry.npmjs.org`, `api.anthropic.com`, `sentry.io`, `statsig.com`, `marketplace.visualstudio.com`, `vscode.blob.core.windows.net` and `update.code.visualstudio.com`.
  - Allows the host's /24.
  - Sets INPUT/FORWARD/OUTPUT policy to DROP and REJECTs everything else.
  - Checks itself: `example.com` must be blocked and `api.github.com` reachable.

Key guidance from the docs:
- Because the container runs as non-root and confines command execution, you can pass `--dangerously-skip-permissions`. "The CLI rejects this flag when launched as root."
- Warning: with that flag, "dev containers do not prevent a malicious project from exfiltrating anything accessible inside the container, including the Claude Code credentials stored in `~/.claude`". The docs also say to avoid mounting host secrets such as `~/.ssh` and to "prefer repository-scoped or short-lived tokens."
- The reference "is provided as a working example rather than a maintained base image."
- To pin the CLI, install `@anthropic-ai/claude-code@X.Y.Z` in the Dockerfile and set `DISABLE_AUTOUPDATER=1`. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns off telemetry and error reporting.
- Managed policy can be baked into the image at `/etc/claude-code/managed-settings.json`. It has the highest precedence on Linux.
- From sandbox-environments: "Always run `--dangerously-skip-permissions` sessions inside a container, a VM, or the sandbox runtime". The built-in Bash sandbox alone "is not sufficient for fully unattended runs" and does not support native Windows.

Weaknesses of the reference firewall that the factory must fix if it copies it:
- It resolves domain IPs **once at start**. CDN-backed hosts (`api.anthropic.com`, `registry.npmjs.org`) can rotate IPs during a long run, which then breaks the connection. This is an inference from how the script works; it is not stated by Anthropic.
- Its allowlist is **out of date** compared with the current network requirements page (https://code.claude.com/docs/en/network-config#network-access-requirements):
  - It allows `sentry.io` and `statsig.com`, but current telemetry goes to Datadog hosts and can be disabled.
  - It lacks `platform.claude.com` and `claude.ai`, which "OAuth token exchange, refresh, and revocation" need. A `/login` session would fail to refresh; a `CLAUDE_CODE_OAUTH_TOKEN` or API key only needs `api.anthropic.com`.
- It allows **all outbound SSH** and the **whole host /24**. Both are broader than an L2 run needs.

## 2. Docker Sandboxes (`sbx`)

Sources:
- Overview: https://docs.docker.com/ai/sandboxes/
- Install: https://docs.docker.com/ai/sandboxes/install/
- Architecture: https://docs.docker.com/ai/sandboxes/architecture/
- Security: https://docs.docker.com/ai/sandboxes/security and https://docs.docker.com/ai/sandboxes/security/defaults
- Credentials: https://docs.docker.com/ai/sandboxes/configuration/credentials/
- Claude Code: https://docs.docker.com/ai/sandboxes/agents/claude-code
- Git workflows: https://docs.docker.com/ai/sandboxes/workflows/git/
- CI and automation: https://docs.docker.com/ai/sandboxes/workflows/automation/
- Usage: https://docs.docker.com/ai/sandboxes/usage/
- Releases: https://github.com/docker/sbx-releases. Latest stable is **v0.48.0** (2026-10-13); v0.49.0-rc3 is out.

**What it is.** A standalone CLI (`sbx`) that runs coding agents in local microVMs, or in Docker-managed cloud sandboxes. "You don't need Docker Desktop or Docker Engine to use `sbx`." The CLI and local compute are "free to use, including for commercial work." It requires a Docker sign-in (`sbx login`). Claude Code's own docs point to it as a VM-class option: https://code.claude.com/docs/en/sandbox-environments#virtual-machine.

**Platforms.**
- Windows 11 only, x86-64, with **Windows Hypervisor Platform** enabled (`Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All`). Install with `winget install -h Docker.sbx`.
- macOS Sonoma 14+ on **Apple silicon only**.
- Ubuntu 24.04+ with KVM.
- Windows 10 is not listed. The operator's Windows 10 22H2 machine is therefore not a supported host.

**Isolation.**
- Each sandbox is a hypervisor-isolated microVM with its own Docker daemon. The agent has sudo inside the VM.
- The host filesystem outside mounted workspaces, the host Docker daemon, the host network, and sandbox-to-sandbox traffic are blocked.

**Claude Code under `sbx`.**
- `sbx run claude <dir>` starts it. The default command is `claude --dangerously-skip-permissions`.
- User-level `~/.claude` is **not** inherited; project-level config is.
- For unattended runs, the docs show `sbx create --name ci-task --clone claude .`, then `sbx exec ci-task -- claude --dangerously-skip-permissions -p "..."`, then `git fetch sandbox-ci-task`, then `sbx rm --force ci-task`. JSON output is available (`--json`), but the format changed in v0.48.0, so pin the version.

**Credentials.**
- `sbx secret set anthropic` (or `github`, etc.) stores values in the OS keychain (Windows Credential Manager or macOS Keychain).
- A host-side proxy swaps a sentinel value for the real credential on outbound requests: "The real credential never enters the sandbox."
- OAuth sign-in for Claude Code (`/login` inside the sandbox) "runs on the host, and the token never enters the sandbox."
- **UNVERIFIED:** whether a `CLAUDE_CODE_OAUTH_TOKEN` (setup-token) can be proxy-injected for headless subscription runs. `sbx secret set-custom --host api.anthropic.com --env ...` is documented as experimental and might work. The documented headless path uses an API key.

**Network.**
- All outbound TCP goes through the host proxy and is "blocked unless an explicit rule allows the destination." UDP and ICMP are blocked.
- Manage rules with `sbx policy ls` and `sbx policy allow`.
- The defaults include broad wildcards such as `*.googleapis.com`; prune them.

**Filesystem and git.** Three modes:
- **Direct**: the host directory is mounted read-write at the same absolute path through a filesystem passthrough (virtiofs cache on).
- **Clone (`--clone`)**: the host repo is mounted read-only at `/run/sandbox/source`. The agent works in a private clone, and the branches come back through a `sandbox-<name>` remote on the host. The mode is fixed when the sandbox is created.
- **Host worktree**: "the `.git` pointer file can't be resolved". The agent has no git access in this mode. Docker's own docs thereby confirm the worktree bind-mount problem described in section 4.

For parallel tasks, Docker recommends clone mode.

**git push / gh.**
- `sbx secret set github --command 'gh auth token'` lets `gh` work inside the sandbox. The token is refreshed from the host every 55 minutes. Injection covers `github.com`, `api.github.com`, `raw.githubusercontent.com` and `gist.github.com`.
- SSH agent forwarding is on by default when `SSH_AUTH_SOCK` is set.
- **UNVERIFIED:** whether `git push` over HTTPS to `github.com` authenticates through the proxy injection without a credential helper. The docs show agents pushing but don't spell out the mechanism. Test it in a spike.

**History note (secondary sources only, UNVERIFIED):** Docker Sandboxes first shipped as an experimental `docker sandbox run claude` command inside Docker Desktop (4.50+, later 4.58+). It is now the standalone `sbx` CLI. Use only the current `sbx` docs.

## 3. Getting Claude credentials into a container

Source: https://code.claude.com/docs/en/authentication

**Precedence:**
1. Cloud-provider variables
2. `ANTHROPIC_AUTH_TOKEN`
3. `ANTHROPIC_API_KEY` (always used in `-p` mode when present)
4. `apiKeyHelper`
5. `CLAUDE_CODE_OAUTH_TOKEN`
6. Anthropic profiles
7. Subscription OAuth from `/login`

**Subscription (Pro/Max).**
- `claude setup-token` runs the browser flow on the host and prints a **one-year** OAuth token. It doesn't store the token anywhere.
- Set the token as `CLAUDE_CODE_OAUTH_TOKEN` in the container. It "requires a Pro, Max, Team, or Enterprise plan" and "can only make model requests" (no Remote Control, no claude.ai connectors).
- `--bare` mode does **not** read it. Bare mode needs `ANTHROPIC_API_KEY` or `apiKeyHelper`.

**API billing.** Pass `ANTHROPIC_API_KEY`. An `apiKeyHelper` script can fetch short-lived keys instead.

**Where host credentials live.** Windows stores them in `%USERPROFILE%\.claude\.credentials.json`, Linux in `~/.claude/.credentials.json` (0600), and macOS in the Keychain. Don't mount these into containers:
- The devcontainer docs warn they can be exfiltrated.
- Several containers sharing one refreshing `/login` credential could race on token refresh (**UNVERIFIED**; it is an inference).

**Safe pattern for the plain-container backend.**
- The factory keeps the token in its own secret store on the host and passes it at `docker run` time as an environment variable inherited from the factory process (`-e CLAUDE_CODE_OAUTH_TOKEN`, with no value on the command line). Never bake it into the image or write it to the workspace.
- Accept the residual risk: the agent can read its own env. Egress limits are what bound the damage.
- Persisting `~/.claude` in a named volume (as the reference does) is optional for ephemeral runs. When it is used, also set `CLAUDE_CONFIG_DIR` so `.claude.json` lands inside the volume.

## 4. Filesystem strategy and performance on Windows

Sources:
- Docker, "WSL 2 best practices": https://docs.docker.com/desktop/features/wsl/best-practices/
- Microsoft, "Working across file systems": https://learn.microsoft.com/en-us/windows/wsl/filesystems (updated 2026-06-02)
- Git, `git-worktree` (manual for 2.56.0): https://git-scm.com/docs/git-worktree
- Docker Desktop synchronized file shares: https://docs.docker.com/desktop/features/synchronized-file-sharing/

What the docs say:
- Docker: "Performance is much higher when files are bind-mounted from the Linux filesystem". It says to avoid `docker run -v /mnt/c/users:/users` and use a path inside WSL instead. Also, "Linux containers only receive file change events, 'inotify events', if the original files are stored in the Linux filesystem".
- Microsoft: "We recommend against working across operating systems with your files". Store files in the WSL filesystem when you work from Linux tools.
- A linked worktree's `.git` is a **file** that points to `<main>/.git/worktrees/<id>` by **absolute path** by default. A worktree on `D:\...` bind-mounted into a Linux container therefore points at a Windows path git cannot resolve. Docker's sbx docs confirm this.
  - `worktree.useRelativePaths` / `--relative-paths` makes the links relative, which could work if the whole repo is mounted with the same layout. However, it turns on `extensions.relativeWorktrees` and so becomes "incompatible with older versions of Git". This is not worth the coupling.
- Synchronized file shares (an ext4 cache inside the Docker Desktop VM) speed up bind mounts. No benchmarks are given, and it is documented as a Docker Desktop paid-tier feature (**UNVERIFIED**: the fetched page did not state the tier).

Options:

| Option | Speed | git works in container | Host sees changes | Fit for L2 |
|---|---|---|---|---|
| Bind-mount host worktree (`D:\...`) | Slow (crosses Windows to WSL VM), no inotify | **No** (absolute `.git` pointer) | Immediately | Poor |
| Worktree in WSL2 ext4 (`\\wsl$`), bind-mounted | Fast | Only if main repo also in WSL and paths match | Via `\\wsl$` | Couples factory to WSL paths |
| **Clone inside container** (container FS or named volume) | Fast (native ext4 in the VM) | Yes | After the agent pushes or the factory fetches | **Good**: mirrors `sbx` clone mode |

**Recommendation.**
- At L2, clone inside the container. The two sources are:
  - **origin on GitHub**, which is simplest and uses the run's scoped token, or
  - **the host repo mounted read-only**, a one-time read across the boundary that avoids a network clone and works for unpushed base branches.
- The agent pushes its branch to GitHub and opens the draft PR. The factory fetches the branch to show diffs in the TUI.
- Worktrees stay the default for L0/L1 runs on the host, as the map already decides.
- On Mac, Docker Desktop bind mounts use VirtioFS. The same clone-inside strategy applies and keeps the backend identical across platforms.

## 5. Restricting network egress

Two patterns for the plain-container backend:

1. **In-container iptables (Anthropic reference).**
   - Needs `--cap-add=NET_ADMIN --cap-add=NET_RAW`.
   - The agent runs as non-root and may only `sudo` the firewall script, so it cannot undo the rules. This rests on the sudoers line in the reference Dockerfile.
   - Drawbacks: IP-based allowlists go stale, and the container holds capabilities.
2. **Internal network plus allowlisting proxy (factory-owned).**
   - Attach the agent container only to a `docker network create --internal` network. The docs say containers there "communicate between each other, but not with any other network" (https://docs.docker.com/reference/cli/docker/network/create/).
   - Run an HTTPS forward proxy container (CONNECT allowlist by hostname) on both that network and a normal one, and set `HTTPS_PROXY` in the agent container. Claude Code "respects standard proxy environment variables" (https://code.claude.com/docs/en/network-config#proxy-configuration).
   - This filters by hostname rather than IP, needs no extra capabilities, and gives the factory one place to log egress. It mirrors `sbx`'s host-proxy design.
   - **UNVERIFIED:** the proxy software and config are a design choice, not taken from a source. Tools that ignore `HTTPS_PROXY` simply fail closed, which is acceptable.

Minimum allowlist for an L2 run with a setup-token or API key:
- `api.anthropic.com`
- `github.com` and `api.github.com` (add `codeload.github.com` / `objects.githubusercontent.com` if the run downloads release assets)
- `registry.npmjs.org` and any other package registries the project needs
- `platform.claude.com` and `claude.ai` only if `/login` credentials are used
- Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and leave out telemetry hosts.

**Residual risk:** allowlisted hosts are still exfiltration channels. For example, a GitHub token with gist scope, or any repo the token can write to. Keep tokens scoped to one repo and no extra permissions.

## 6. git push and gh authentication from inside the container

Sources:
- PATs: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- App installation tokens: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app and https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
- gh CLI: https://cli.github.com/manual/gh_help_environment and https://cli.github.com/manual/gh_auth_setup-git

What the docs say:
- **Fine-grained PAT**: limited to one resource owner and to selected repositories, with per-permission read/write (Contents, Pull requests). GitHub recommends fine-grained over classic tokens. PATs act on your own behalf. "To access resources on behalf of an organization, or for long-lived integrations, you should use a GitHub App."
- **GitHub App installation token**: "will expire after 1 hour". It can be narrowed at mint time with `repositories` / `repository_ids` and `permissions`. It works for HTTPS git as `https://x-access-token:TOKEN@github.com/owner/repo.git` and needs the Contents permission. Actions "are attributed to the app."
- **gh**: `GH_TOKEN` (then `GITHUB_TOKEN`) "takes precedence over previously stored credentials." `gh auth setup-git` "configures `git` to use GitHub CLI as a credential helper", so `git push` over HTTPS reuses the same token.

**Recommendation.**
- Per run, the host-side factory mints or selects a token scoped to **one repo** with **Contents: write, Pull requests: write** (Metadata: read is implied). It passes the token as `GH_TOKEN`, and the container entrypoint runs `gh auth setup-git`.
  - **UNVERIFIED:** that `setup-git` accepts an env-only token as "authenticated". The fallback is a one-line credential helper that echoes `$GH_TOKEN` with username `x-access-token`.
- The agent then runs `git push -u origin <branch>` and `gh pr create --draft`.
- Prefer a GitHub App installation token (1 hour, bot attribution, no long-lived secret in the container). A fine-grained PAT with a short expiry is the simpler fallback. Which identity to use is the open "Secrets and identity" question on the map; this research only shows both work in a container.
- Don't forward SSH agents or mount `~/.ssh` (devcontainer docs).
- Protect `main` with a branch ruleset so that even a leaked token cannot merge or push to it. This matches the map's "operator always merges".

## 7. Mac notes

- **`sbx`**: macOS 14+ on Apple silicon; Intel Macs are not listed. Credentials go in the macOS Keychain.
- **Plain-container backend**: Docker Desktop for Mac works the same way. Clone-inside avoids bind-mount performance concerns entirely.
- **Claude credentials on a Mac host** live in the Keychain, which is another reason to use `setup-token` instead of mounting host files.

## Open questions for the spec

- Will the operator move to Windows 11 (Windows 10 22H2 left Microsoft support on 2025-10-14, per https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro)? Docker Desktop says it supports only Windows versions "still within Microsoft's servicing timeline". This decides whether `sbx` can be the first backend.
- Can a subscription setup-token be proxy-injected under `sbx` (`set-custom`), or does headless `sbx` require an API key? A spike is needed.
- Is in-container iptables or an internal network plus proxy the egress mechanism for the plain-container backend? The proxy is recommended.
- Should the image pin a Claude Code version (`npm i -g @anthropic-ai/claude-code@X.Y.Z` with `DISABLE_AUTOUPDATER=1`) per factory release? This ties into the "Skill provisioning" reproducibility question.
