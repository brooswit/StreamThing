# Changelog

All notable changes to StreamThing are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.8] — 2026-07-05

### Added

- **Delete** button on archived items — permanently removes the file and row (with a confirm). The
  server rejects deleting active-library items, so archiving stays the deliberate first step.

### Changed

- **Compact conversion.** Output is now downscaled to ≤720p at CRF 26 (AAC 128k) by default, always
  re-encoded (no fast remux), for much smaller files. Still H.264/AAC (the only thing browsers play),
  so size comes from resolution + CRF. Tunable via `CONVERT_MAX_HEIGHT`, `CONVERT_CRF`,
  `CONVERT_PRESET`, `CONVERT_AUDIO_KBPS`.
- The **converting** progress bar is amber, distinct from the blue **downloading** bar.

## [1.0.7] — 2026-07-05

### Added

- **Multi-file downloads (season packs).** A torrent with several video files now becomes one
  playable item per episode, instead of keeping only the largest file and deleting the rest. Each
  file is moved into its own media item, converted, and titled after its filename; samples/extras are
  filtered out (files below `MIN_EPISODE_BYTES`, default 50 MiB, or under 15% of the largest file).
  Boot-recovery is multi-file aware, so a crash mid-conversion re-processes every episode.
- `MIN_EPISODE_BYTES` env var to tune the sample-filter threshold.

## [1.0.6] — 2026-07-05

### Fixed

- Download/convert progress is now a single **global feed** broadcast to every connected client,
  instead of only the room that started the download. The downloads strip already listed all
  in-progress items regardless of room, but live updates were room-scoped — so items with no
  originating room (notably boot-recovery conversions) appeared frozen at "Converting 0%".

## [1.0.5] — 2026-07-05

### Fixed

- Crash/power-loss recovery for conversions. On boot, the app already resumed interrupted downloads
  from their magnet; it now also re-runs conversions that were interrupted mid-encode, using the
  source file still on disk (originals are only deleted after a successful conversion). Previously a
  download caught mid-conversion would be stuck in the `converting` state forever.

## [1.0.4] — 2026-07-05

### Added

- **Post-download conversion to a browser-playable format.** When a download finishes, it's
  transcoded once to the universally-supported **MP4 / H.264 (High, 8-bit) / AAC** (`+faststart`),
  the original is deleted, and only then is it marked available. Streams that are already compatible
  are copied (fast remux, no re-encode); incompatible ones (HEVC, 10-bit, AC-3, MKV, …) are
  re-encoded. This is a one-time cost per item — no per-view transcoding. Adds a `converting` media
  state and a "Converting NN%" phase in the room's downloads strip. ffmpeg ships via the
  `ffmpeg-static` npm package, so there's no separate system install.

## [1.0.3] — 2026-07-05

### Changed

- Room UI: moved search to a full-width bar at the top; fixed-height app shell so the player no
  longer pushes content off-screen; player height is capped.
- Search returns local library/archive results instantly and loads external sources separately, with
  a loading spinner and per-source status ("unavailable — try again" instead of a silent empty list).
- The Pirate Bay source retries on failure (apibay is often slow/flaky) and reports timeouts clearly.

### Fixed

- Stylesheet is served with `Cache-Control: no-cache`, so CSS updates aren't masked by Bun's stable
  dev asset URL + browser caching.

## [1.0.2] — 2026-07-05

### Added

- CI: automatically create the git tag and GitHub release (with notes from the changelog) whenever
  the version on `main` changes.

## [1.0.1] — 2026-07-05

### Removed

- `SESSION_SECRET` config — it was never used. Sessions are opaque random DB-backed tokens (not
  signed cookies), so no secret is needed.

## [1.0.0] — 2026-07-05

Initial release: a minimal, self-hosted shared media room app on a single Bun process.

### Added

- **Rooms** — visiting `/` optimistically generates a room and redirects to `/r/<slug>`; rooms are
  created on first visit and kept forever. No room list, no pre-check, collisions reuse the room.
- **Accounts & sessions** — username/password auth with argon2id hashing (`Bun.password`), opaque
  server-side sessions in an httpOnly cookie. Optional open registration (`ALLOW_REGISTRATION`).
- **Synchronized playback** — server-authoritative room state over Bun's native pub/sub WebSockets;
  `LOAD_MEDIA` / `PLAY` / `PAUSE` / `SEEK` mirror to everyone, with clock-derived position and
  echo-suppressed client sync.
- **Unified search** — one search box returns three ordered sections: shared library, archive, and
  external sources.
- **In-process torrents** — downloads run inside the app via WebTorrent; media transitions
  `downloading → available` and appears live in the room with progress.
- **Download-only enforcement** — the torrent engine never uploads file content: `uploads: 0`,
  re-choke on interest, neutered piece-send path (blocks even BEP6 allowed-fast), and torrents are
  destroyed on completion so nothing seeds afterward.
- **Archive & restore** — archiving removes an item from the active library but retains the file
  (searchable, restorable); no hard delete in the normal flow.
- **Per-user quotas** — active storage is attributed to the importing user (reject-on-exceed);
  archives are purged oldest-first when over the archive quota.
- **Range streaming** — `<video>`-friendly HTTP range requests for seek support.
- **Chat** — minimal per-room chat alongside the player.
- **Pluggable sources** — `MediaSourceAdapter` interface + registry; the room/search UI is
  source-agnostic. Ships with a `tpb` (The Pirate Bay / apibay.org) adapter.
- **Ops** — single Bun process, single SQLite file (`bun:sqlite`, WAL), no build step; frontend
  bundled at runtime by Bun. Coarse logging of auth, playback, downloads, source errors, and purges.

### Notes

- WebTorrent is constructed with `{ utp: false }` to run under Bun (µTP's native module uses a libuv
  timer Bun does not implement); WebRTC is avoided (no `wss` trackers). TCP + DHT + UDP/HTTP trackers
  are used.

[1.0.8]: https://github.com/brooswit/StreamThing/releases/tag/v1.0.8
[1.0.7]: https://github.com/brooswit/StreamThing/releases/tag/v1.0.7
[1.0.6]: https://github.com/brooswit/StreamThing/releases/tag/v1.0.6
[1.0.5]: https://github.com/brooswit/StreamThing/releases/tag/v1.0.5
[1.0.4]: https://github.com/brooswit/StreamThing/releases/tag/v1.0.4
[1.0.3]: https://github.com/brooswit/StreamThing/releases/tag/v1.0.3
[1.0.2]: https://github.com/brooswit/StreamThing/releases/tag/v1.0.2
[1.0.1]: https://github.com/brooswit/StreamThing/releases/tag/v1.0.1
[1.0.0]: https://github.com/brooswit/StreamThing/releases/tag/v1.0.0
