[简体中文](./README.zh-CN.md) · **English**

# fulcrum-toolchain

The command line for the micro-frontend workflow: start the host, spawn remotes, build the site,
reap orphans, run the gates, fake a test environment.

```bash
pnpm add -D fulcrum-toolchain
```

This gives you the `fulcrum` command.

## Commands

```bash
fulcrum dev                    # start the host (no remotes spawned)
fulcrum dev -- child child2    # also spawn in-repo remotes (--all for every one)
fulcrum build [names...]       # build the site → dist/site (--clean wipes, --with <name> builds in that repo)
fulcrum preview [port]         # serve dist/site with production-style routing
fulcrum stop                   # reap orphans by port when pid files are gone
fulcrum check                  # 6 gates
fulcrum mock-env <port> [dir]  # fake "test environment" for exercising fallbacks
```

`cwd` is the project root; the manifest is looked up to 3 levels above it, so running from `src/` or
`app/` works.

## Why the CLI is its own package

The CLI needs the entry plugin's internals: manifest parsing, three-tier target resolution, artifact
manifests, port reverse lookup. Exporting each of those would freeze them into public API — rename
an internal helper and you break semver.

So `fulcrum-entry-vite` opens exactly one door:

```js
import { loadManifest, buildProxy, resolveArtifact } from 'fulcrum-entry-vite/internal';
```

The door is labelled `internal`: the plugin is public API, these are implementation details. The CLI
depends on it as a separate package and both versions move together inside the monorepo, while the
plugin keeps its clean boundary of exporting only `fulcrum()`.

Two side benefits: people who only want the plugin don't get a CLI installed, and a global
`pnpm add -g fulcrum-toolchain` doesn't drag the plugin along.

## What `dev` does

```
[dev] 1/6 read manifest
[dev] 2/6 port health check (base 8000, spawning no sub-apps)
[dev] 3/6 generate proxy (a broken manifest explodes right here)
[dev] 4/6 skip: no sub-apps to spawn
[dev] 5/6 skip: no sub-apps spawned
[dev] 6/6 start base
```

Six checkpoints, so a hang tells you exactly where it stopped. That exists because "pnpm run dev
hangs with zero output" was a real incident.

Behaviour that matters:

- **Spawns no remotes by default** — run `pnpm dev` in each remote repo; the host discovers the
  port within 2s
- **Reuses a running host** — verifies that whoever owns 8000 answers `GET /__mf/status` like this
  template's host; if so, it only starts this run's remotes instead of fighting for the port
- **Never silently picks another port** — a taken port fails loudly and names the owner
- **Never spawns vite through npx** — it runs `node <found vite>/bin/vite.js`, so a missing local
  install can't trigger an interactive npx prompt (which looks like a silent hang in scripts) and
  there is no extra `sh -c` layer leaving orphans after Ctrl-C

## What `build` does

```bash
fulcrum build              # host + every remote → dist/site (clean rebuild)
fulcrum build -- child     # incremental: rebuild A only, keep the others
fulcrum build -- --clean   # force a full wipe
fulcrum build --with child # run that remote's own build in its repo, then collect the output
```

One root serves every app, so no per-remote alias is needed:

```
dist/site/
  index.html        host
  assets/…          host assets
  child/index.html  A → /child/
  child2/index.html B → /child2/
dist/fulcrum-manifest.json   build manifest
dist/nginx.conf              ready-to-use sample config
```

When a remote's source isn't available cross-repo, a failed build **falls back to the last artifact
and warns** instead of failing the whole release — silently shipping a stale bundle is the hardest
kind of incident to trace.

## The 6 gates in `check`

| Gate | Checks |
|---|---|
| 1 | manifest shape and `base` prefix collisions (`/child` would swallow `/child2`) |
| 2 | every remote resolves to a target (local, artifact, or remote) |
| 3 | proxy rules match the manifest, all with `ws: true` and a timeout |
| 4 | no remote URL literals in host sources (whole host dir scanned, comments and tests skipped) |
| 5 | `__MF_*__` build injections were replaced by literals in the output |
| 6 | local overrides like `.mf-dev-local.json` were not committed |

Gate 4 deliberately has **no hardcoded file list** — a fixed list silently stops covering anything
once the directory layout changes.

## Why `stop` is long

It doesn't rely on `ss` / `lsof` being installed: first `.dev-pids.json`, then reverse-lookup by
manifest port (`ss` → `lsof` → reading `/proc/net/tcp` and fds directly), then a real TCP connect to
confirm. It never claims "port released" when it isn't.

## Environment variables

| Variable | Purpose |
|---|---|
| `MF_MANIFEST` | Manifest path (e.g. switch to `apps.manifest.demo.json`) |
| `MF_APPS_DIR` | Root searched when resolving cross-repo artifacts |
| `MF_LOCAL_APPS` | Which apps this machine started (avoids depending on a state file) |
| `MF_HOST` | Host URL used by verification |

## License

MIT
