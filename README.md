# StreamThing

A minimal, self-hosted **shared media room** app. Open a room by URL, search across your
library / archive / torrent sources, download or play media, and **watch together** with
synchronized playback and lightweight chat. Built for a handful of trusted users on one server —
not a streaming platform.

- **Room-first:** visit `/` and you're dropped into a fresh room; share the URL to watch together.
- **Search-first:** one search box spans your shared library, your archive, and external sources.
- **Synchronized playback:** play / pause / seek / load are mirrored to everyone in the room.
- **In-process torrents:** downloads run inside the app via WebTorrent — no external torrent client.
- **Per-user quotas:** storage is attributed to whoever imported it; everyone can watch everything.
- **Single server, no build step:** one Bun process, one SQLite file, `bun start` and go.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- A Linux/macOS host with outbound network access (for trackers, DHT, and source search)

## Setup

```bash
bun install                  # installs deps; builds native torrent modules (trusted in package.json)
cp .env.example .env          # optional — tweak port and quotas
bun start                     # http://localhost:3000
```

For development with auto-reload:

```bash
bun run dev
```

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP/WS port |
| `DATA_DIR` | `./data` | SQLite DB + downloaded media live here |
| `DEFAULT_STORAGE_QUOTA_BYTES` | 10 GiB | Active-storage quota for new users |
| `DEFAULT_ARCHIVE_QUOTA_BYTES` | 20 GiB | Archive quota for new users |
| `ALLOW_REGISTRATION` | `true` | Set `false` after creating your accounts |

## How it works

Visiting `/` redirects you to a freshly-generated room (`/r/<slug>`); rooms are created
optimistically and kept forever. In a room you can:

- **Tabs** — the room has **Player · Library · Download · Admin** tabs (Admin only for admins). The
  player stays mounted across tabs, so synced playback keeps running while you browse; chat is always
  visible in the sidebar.
- **Library / Download** — the **Library** tab searches your library + archive (play / archive /
  restore / delete); the **Download** tab searches external sources and shows download/convert
  progress.
- **Admin** — admins get a tab to set each user's active + archive quotas (with Reset to default) and
  toggle admin. Lowering a user's active quota auto-archives the **fewest** files (largest-first) to
  get under; lowering the archive quota deletes oldest-first. The last admin can't be demoted. Admins
  are designated by the `is_admin` flag; the first account created is an admin.
- **Download** — pick a source result; the app resolves the magnet, downloads it in-process, then
  **converts it once** to a browser-playable MP4 (see below) and deletes the original. Download and
  conversion progress both show in the room; the item becomes playable when conversion finishes.
- **Archive / restore** — archiving removes an item from the active library but keeps the file
  (searchable, restorable). If your archive exceeds quota, the oldest archived items are purged first.
- **Watch together** — playback state is server-authoritative and broadcast to everyone in the room.
- **Chat** — a small per-room chat alongside the player.

### Media lifecycle

`downloading → converting → available → archived` (with `failed` for errors). There is no hard
delete in the normal flow — archive first.

### Playback conversion

Browsers can only play a narrow set of codecs, but most torrent releases use HEVC/H.265, 10-bit
video, AC-3 audio, or MKV — none of which a `<video>` element can decode. So after a download
finishes, StreamThing converts it **once** to the universally-supported format — **MP4 / H.264
(High, 8-bit) / AAC**, with `+faststart` — downscaled to keep files compact (≤720p, CRF 26 by
default), and deletes the original. Since browsers only play H.264/AAC, compactness comes from
resolution + CRF rather than a more efficient codec. Tune via `CONVERT_MAX_HEIGHT`, `CONVERT_CRF`,
`CONVERT_PRESET`, `CONVERT_AUDIO_KBPS` (see `.env.example`). This is a one-time cost per item (no
per-view transcoding). A torrent with multiple videos (a season pack) becomes one item per episode.
ffmpeg ships via the `ffmpeg-static` npm package, so there's no separate system install.

Archived items can be permanently **deleted** (removing the file) — the one place hard delete is
offered, since archiving is the deliberate first step.

## Architecture

One Bun app (`src/index.ts`) serving the API, the bundled frontend (`web/`), and room WebSockets.

```
src/
  auth/       accounts, sessions, cookies
  rooms/      slug generation, canonical playback state
  chat/       per-room messages
  media/      media lifecycle, library/archive search, quota accounting
  sources/    pluggable source adapters (types + registry + tpb/)
  downloads/  in-process WebTorrent orchestration
  storage/    filesystem layout, archive moves, oldest-first purge
  http/       REST handlers + range streaming
  ws/         playback sync + chat + live download feed
  db/         SQLite schema + connection
web/          room SPA + login page (bundled at runtime by Bun)
```

### Adding a media source

Implement the `MediaSourceAdapter` interface in `src/sources/types.ts` (an `id`, a `label`, and a
`search(query)` returning normalized `SearchResult`s with a `magnet`), then `register()` it in
`src/sources/registry.ts`. The room and search UI are source-agnostic.

The bundled `tpb` source searches The Pirate Bay via apibay.org (adapted from the author's
ThePirateBayJS / MagnetLinkJS libraries).

## Notes

- **Download-only (no seeding/uploading):** the torrent engine never sends file content. It runs with
  `uploads: 0` (peers are never unchoked), re-chokes any interested peer, neuters the piece-send path
  so even BEP6 "allowed-fast" requests can't leak content, and destroys each torrent on completion so
  nothing seeds afterward. A tiny amount of BitTorrent control traffic (handshakes, bitfields, and
  serving the public `.torrent` metadata) is unavoidable to stay in a swarm and keep downloading — no
  file bytes are ever uploaded.
- **Runtime caveat:** WebTorrent is constructed with `{ utp: false }` — µTP's native module uses a
  libuv timer Bun doesn't implement, and WebRTC is avoided (no `wss` trackers). TCP + DHT + UDP/HTTP
  trackers are used, which is plenty for a server-side downloader.
- Only download content you have the right to. This tool searches and fetches whatever a source
  returns.
