# Changelog

All notable changes to StreamThing are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.2]: https://github.com/brooswit/StreamThing/releases/tag/v1.0.2
[1.0.1]: https://github.com/brooswit/StreamThing/releases/tag/v1.0.1
[1.0.0]: https://github.com/brooswit/StreamThing/releases/tag/v1.0.0
