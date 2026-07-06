// Magnet-link generation. Vendored from the user's MagnetLinkJS (@alphonsebizaar/magnetlinkjs)
// to avoid its `file:../MagnetLinkJS` local dependency. Original by brooswit, MIT.
const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.bittor.pw:1337/announce",
  "udp://tracker.dler.org:6969/announce",
  "udp://exodus.desync.com:6969",
  "udp://open.demonii.com:1337/announce",
  "udp://p4p.arenabg.com:1337",
  "udp://tracker.internetwarriors.net:1337",
];

export function createMagnetLink(infoHash: string, name: string, trackers: string[] = DEFAULT_TRACKERS): string {
  if (!infoHash || !name) throw new Error("Info hash and name are required");
  const encodedName = encodeURIComponent(name);
  const trackerParams = trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodedName}${trackerParams}`;
}
