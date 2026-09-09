# known issue: yt-session-generator is flaky for YouTube poToken

`yt-session-generator` (used in `compose.yml` for `YOUTUBE_SESSION_SERVER`) does
not reliably produce a poToken in our environment (rootless podman). This is a
**known, unresolved upstream bug** — not something specific to our compose setup.

## symptoms

- `cobalt` logs every few minutes:
  ```
  [!] Failed loading poToken & visitor_data
  ```
- YouTube downloads intermittently return a `tunnel` response that resolves to
  an empty file (`Content-Length: 0`) instead of the actual video.
- `yt-session-generator` logs:
  ```
  [extractor] [INFO] update started
  [extractor] [WARNING] update failed: timeout waiting for outgoing API request
  ```
- `POST /get_pot` on the session generator returns `404` while this is happening.

## root cause

Matches upstream issue exactly:
[imputnet/yt-session-generator#3](https://github.com/imputnet/yt-session-generator/issues/3)
("Chromium fails to start as root — need `no_sandbox=True`").

The container runs Chromium as root (by design). Its browser automation lib
(`nodriver`) has logic to auto-disable the sandbox when it detects root
(`nodriver/core/config.py`), but that path isn't reliably taking effect in the
`ghcr.io/imputnet/yt-session-generator:webserver` image — Chromium's sandbox
then refuses to start, the extractor never sees the outgoing YouTube API
request it's waiting for, and it times out.

We confirmed in our environment (rootless podman on WSL2):
- `/dev/shm` at the podman default (64MB) crashes Chromium outright — fixed
  with `shm_size: 1gb` in `compose.yml`.
- Even with that fixed, the extractor still times out — Chromium itself works
  fine standalone (verified via manual `--remote-debugging-port` + CDP check),
  but the app's own launch path doesn't get past the sandbox issue above.

## current status / what to do

- No upstream fix yet (issue open, 0 comments as of writing).
- `compose.yml` still wires up `yt-session-generator` — treat YouTube
  downloads as **best-effort**, not guaranteed. TikTok, Instagram, Threads,
  etc. are unaffected (no poToken dependency).
- If this needs to actually be reliable, options (not yet attempted):
  1. Watch/comment on upstream issue #3 for a fix.
  2. Fork `yt-session-generator`, pin/patch `nodriver` so `sandbox=False` is
     forced explicitly instead of relying on its root auto-detect, rebuild
     the image (same pattern as our `cobalt` threads fork).
  3. Drop `yt-session-generator` entirely and accept that YouTube tunnels can
     silently come back empty.
