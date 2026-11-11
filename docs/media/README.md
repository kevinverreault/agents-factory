# The README's media

The GIFs and screenshots here are played from the scenes in `src/demo/scenes.ts`. Each scene is a list of keys and text, paced for a reader to follow. The scenes type into `npm run demo`: the real TUI over a made-up factory, whose connection answers the TUI's commands as the daemon would. Two recorders play the same scenes:

| Recorder | Command | Needs | Makes |
|---|---|---|---|
| vhs | `npm run media:vhs` | `vhs`, `ttyd`, `ffmpeg` and a Chromium on the `PATH` | the four GIFs, from `tapes/*.tape` |
| Headless | `npm run media` | nothing beyond `npm install` | the four GIFs and the screenshots |

`npm run tapes` writes `tapes/*.tape` from the scenes. Don't edit a tape by hand: `npm test` fails when a committed tape no longer matches its scene.

## Why the committed GIFs aren't from vhs

The committed media were recorded in an L2 run, inside the task's container. Its egress goes through the task's proxy, which allows only the built-in hosts plus the task's own ([ADR 0007](../adr/0007-autonomy-bounds-containment-and-publishing.md)): `api.anthropic.com`, `api.github.com`, `github.com` and `registry.npmjs.org`. On 2026-11-11 that left vhs out of reach:

| vhs needs | Where it comes from | In the container |
|---|---|---|
| `vhs` | GitHub release assets: `github.com/…/releases/download/…` redirects to `release-assets.githubusercontent.com` | Denied by the proxy (`CONNECT tunnel failed, response 403`) |
| `ttyd` | GitHub release assets, the same way | Denied by the proxy |
| `ffmpeg` | `@ffmpeg-installer/linux-x64` on npm ships the binary in its package | Works |
| Chromium | `@sparticuz/chromium` on npm ships it compressed; vhs finds a browser on the `PATH` | Works headless, with the package's flags and its libraries unpacked on `LD_LIBRARY_PATH` |

Building vhs or ttyd from source in the container isn't possible either. It has no Go toolchain or C compiler, the Go module proxy is denied, and `apt` needs root and `deb.debian.org`.

So the blocker is one host. To record with vhs in an L2 run, allow `release-assets.githubusercontent.com` for the task: **Allow host for this task and retry** on its Needs you item, or the task's egress hosts. Then fetch vhs and ttyd from their releases and ffmpeg and Chromium from npm, as above, and run `npm run media:vhs`.

On a machine with vhs installed, such as the operator's Windows machine (`winget install charmbracelet.vhs`, plus ttyd and ffmpeg), `npm run media:vhs` records the GIFs directly. On Windows, vhs types into `cmd`, the shell it uses by default there.
