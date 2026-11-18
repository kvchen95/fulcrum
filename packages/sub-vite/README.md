**English** · [简体中文](./README.zh-CN.md)

# @fulcrum/sub-vite

The **sub-app side** Vite plugin for micro-frontends (loader-agnostic: wujie / qiankun / micro-app). Two small plugins, one job each:

| Plugin | When | What it does |
|---|---|---|
| `announce()` | dev server start / stop | POSTs to the host's `/__mf/announce` so it knows your port **immediately** |
| `artifactManifest()` | after build | Writes `fulcrum-artifact.json` into the output dir so the host can find this build with zero config |

The core rule: **if the host is unreachable, skip silently.** A sub-app must run fine standalone
(`pnpm dev` with no host) and in CI (no host at all). "Couldn't notify" is never a failure.

> Companion host-side plugin: [@fulcrum/entry-vite](../entry-vite/README.md)

## Install

```bash
pnpm add -D @fulcrum/sub-vite
```

## Quick start

### 1. Declare `appName` in `package.json`

```json
{
  "name": "@fulcrum/child-two",
  "appName": "child2"
}
```

`appName` is the **micro-frontend id** and must equal the `name` field of that app in the host's
manifest.

Why not the package name: package names carry a scope (`@fulcrum/child-two`), change on release, and
collide across private forks. `appName` is stable. You can omit it (it falls back to `name` with a
warning), but declaring it is recommended.

### 2. Add the plugins

```js
// vite.config.js
import { defineConfig } from 'vite';
import { announce, artifactManifest } from '@fulcrum/sub-vite';

export default defineConfig({
  base: '/child2/',
  plugins: [announce(), artifactManifest()],
});
```

Or both at once:

```js
import allPlugins from '@fulcrum/sub-vite';
plugins: [allPlugins()];
```

### 3. Develop as usual

```bash
pnpm dev
```

Terminal output:

```
[fulcrum-sub] app name: child2                           # app name resolved
[fulcrum-sub] announced to host: child2 on :7002/child2/ # host notified
```

The host immediately reports `source: "announce"` and the page switches with zero delay — no
waiting for a scan.

## Behavior details

### On dev server start

- Reports after the `listening` event, when the port is final (including the case where vite grabs
  a different port at the last moment)
- Payload: `{ appName, port, base }`
- The host **re-verifies** it (`GET {base}` must return HTML whose assets carry the base prefix);
  it does not trust the report blindly
- Host not running / network down → one informational line, then carry on. **The dev server is unaffected**

### On dev server stop

POSTs `/__mf/unannounce` on `close`, so the host releases the claim immediately and the page falls
back to artifacts or the test environment. Timeout is 300ms — the process is about to exit, waiting
longer buys nothing.

### After build

`closeBundle` runs after output is written and writes:

```json
{
  "appName": "child2",
  "base": "/child2/",
  "builtAt": "2026-11-18T06:12:00.000Z",
  "commit": "a1b2c3d",
  "name": "@fulcrum/child-two"
}
```

`commit` comes from `GIT_COMMIT` / `CI_COMMIT_SHA`, otherwise `null`. A write failure only warns —
**it never breaks the build output**.

## Options

### `announce(opts)`

| Option | Type | Default | Description |
|---|---|---|---|
| `appName` | `string` | `package.json` `appName`, falling back to `name` | Override the app name |
| `baseUrl` | `string` | `http://127.0.0.1:8000` | Host URL; `MF_BASE_URL` also works |
| `quiet` | `boolean` | `false` | Silence logs (nicer in CI) |

### `artifactManifest(opts)`

| Option | Type | Default | Description |
|---|---|---|---|
| `appName` | `string` | same as above | Override the app name |
| `quiet` | `boolean` | `false` | Silence logs |

The output directory comes from vite's `build.outDir`, `base` from `config.base`.

## Environment variables

| Variable | Purpose |
|---|---|
| `MF_BASE_URL` | Host URL, overrides the `http://127.0.0.1:8000` default |
| `GIT_COMMIT` / `CI_COMMIT_SHA` | Written into the artifact manifest as `commit` |

If the host runs on another machine:

```bash
MF_BASE_URL=http://192.168.1.20:8000 pnpm dev
```

## Can I skip this plugin?

Yes. The host then falls back to **scan mode**: every 2s it enumerates listening ports, maps
port → pid → cwd → `package.json` → `appName`, and runs an HTTP check.

The cost is **up to 2s of discovery latency** plus a process scan whenever the port set changes
(~10ms on a real machine). If that's acceptable, you don't need this plugin — scanning is the
zero-dependency default path.

## Why not just fire an HTTP request?

You can, but three things are easy to get wrong, and the plugin handles all three:

1. **Timing** — you must report after `listening` to get the real port. Reading
   `server.config.server.port` inside `configureServer` gives you the configured value, which is
   wrong if the port was taken and vite moved.
2. **Silent failure** — with no host running, `fetch` throws `ECONNREFUSED`. Without try/catch that
   looks like "the dev server won't start". The plugin uses an 800ms timeout and swallows the error.
3. **Cleanup on exit** — without an `unannounce`, the host thinks you're still up and the page keeps
   pointing at a dead port (spinner or 502). The plugin sends a short-timeout report on `close`.

## FAQ

**Q: Do I need to restart the sub-app after restarting the host?**
No. The host discovers you within 2s of starting. With this plugin you can also restart the sub-app
for zero latency, but waiting for the scan works too.

**Q: What happens if the `base` doesn't match?**
The host refuses the claim and says why (`reported base "/x/" differs from manifest "/child2/"`).
That's far easier to debug than "connected but blank".

**Q: Two worktrees running the same app?**
The host picks the lower port. Pin a specific port via `port` in the host manifest, or
`pin: "remote"` to force the non-local path.

## License

MIT
