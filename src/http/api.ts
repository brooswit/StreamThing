// REST API handlers. Playback + chat go over WebSocket; everything else is here.
import { config } from "../config.ts";
import {
  register,
  login,
  createSession,
  destroySession,
  sessionCookie,
  clearCookie,
  tokenFromRequest,
  userFromRequest,
  AuthError,
  type User,
} from "../auth/index.ts";
import { ensureRoom, getRoomState } from "../rooms/index.ts";
import {
  getMedia,
  searchLibrary,
  searchArchive,
  listDownloading,
  createDownloadingMedia,
  archiveMedia,
  restoreMedia,
  deleteMedia,
  mediaToJSON,
  MediaError,
} from "../media/index.ts";
import { quotaSnapshot, wouldExceedActive } from "../media/quota.ts";
import { searchAllSources } from "../sources/registry.ts";
import { getAdapter } from "../sources/registry.ts";
import { startDownload, abortMedia } from "../downloads/index.ts";
import type { Media } from "../media/index.ts";

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}
function error(message: string, status = 400): Response {
  return json({ error: message }, { status });
}

async function body(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function mapMedia(m: Media) {
  const base = mediaToJSON(m);
  const playable = m.state === "available" || m.state === "archived";
  return { ...base, streamUrl: playable ? `/api/media/${m.id}/stream` : null };
}

// --- config / session ---
export function getConfig(): Response {
  return json({ allowRegistration: config.allowRegistration });
}

export function getMe(req: Request): Response {
  const user = userFromRequest(req);
  if (!user) return error("Not authenticated", 401);
  return json({ user: publicMe(user), quota: quotaSnapshot(user.id) });
}

function publicMe(u: User) {
  return { id: u.id, username: u.username };
}

async function authResponse(user: User): Promise<Response> {
  const token = createSession(user.id);
  return json({ user: publicMe(user), quota: quotaSnapshot(user.id) }, { headers: { "Set-Cookie": sessionCookie(token) } });
}

export async function postRegister(req: Request): Promise<Response> {
  const { username, password } = await body(req);
  try {
    const user = await register(String(username ?? ""), String(password ?? ""));
    return authResponse(user);
  } catch (e) {
    if (e instanceof AuthError) return error(e.message, 400);
    throw e;
  }
}

export async function postLogin(req: Request): Promise<Response> {
  const { username, password } = await body(req);
  try {
    const user = await login(String(username ?? ""), String(password ?? ""));
    return authResponse(user);
  } catch (e) {
    if (e instanceof AuthError) return error(e.message, 401);
    throw e;
  }
}

export function postLogout(req: Request): Response {
  const token = tokenFromRequest(req);
  if (token) destroySession(token);
  return json({ ok: true }, { headers: { "Set-Cookie": clearCookie() } });
}

// --- rooms ---
export function getRoom(req: Request, slug: string): Response {
  const user = userFromRequest(req);
  if (!user) return error("Not authenticated", 401);
  ensureRoom(slug, user.id);
  const state = getRoomState(slug);
  const currentMedia = state.mediaId ? getMedia(state.mediaId) : null;
  return json({
    slug,
    state,
    currentMedia: currentMedia ? mapMedia(currentMedia) : null,
    downloading: listDownloading().map(mapMedia),
  });
}

export function getMediaOne(req: Request, id: string): Response {
  const user = userFromRequest(req);
  if (!user) return error("Not authenticated", 401);
  const m = getMedia(id);
  if (!m) return error("Media not found", 404);
  return json({ media: mapMedia(m) });
}

// --- unified search (library → archive → external sources; brief §5.1) ---
// `scope=local` returns library+archive (instant); `scope=sources` returns external sources (slow).
// No scope returns everything. Splitting lets the UI show local results without waiting on sources.
export async function getSearch(req: Request): Promise<Response> {
  const user = userFromRequest(req);
  if (!user) return error("Not authenticated", 401);
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const scope = url.searchParams.get("scope");

  const out: Record<string, unknown> = { query: q };
  if (scope !== "sources") {
    out.library = searchLibrary(q).map(mapMedia);
    out.archive = searchArchive(q).map(mapMedia);
  }
  if (scope !== "local") {
    out.sources = await searchAllSources(q);
  }
  return json(out);
}

// --- downloads ---
export async function postDownload(req: Request): Promise<Response> {
  const user = userFromRequest(req);
  if (!user) return error("Not authenticated", 401);
  const { source, externalId, magnet, title, roomId, sizeBytes } = await body(req);

  if (!magnet || typeof magnet !== "string" || !magnet.startsWith("magnet:")) return error("A magnet link is required");
  if (!source || !getAdapter(String(source))) return error("Unknown source");
  const estimate = Number(sizeBytes) || 0;
  if (estimate > 0 && wouldExceedActive(user.id, estimate)) {
    return error("This download would exceed your active storage quota.", 413);
  }

  const media = createDownloadingMedia({
    title: String(title ?? "Untitled").slice(0, 300),
    sourceType: String(source),
    externalId: externalId ? String(externalId) : null,
    importedBy: user.id,
    magnet,
    metadata: { estimatedSize: estimate || undefined },
  });
  const jobId = startDownload({ media, userId: user.id, roomId: roomId ? String(roomId) : null, magnet });
  return json({ media: mapMedia(media), jobId });
}

// --- archive / restore ---
export function postArchive(req: Request, id: string): Response {
  const user = userFromRequest(req);
  if (!user) return error("Not authenticated", 401);
  try {
    const m = archiveMedia(id);
    return json({ media: mapMedia(m), quota: quotaSnapshot(user.id) });
  } catch (e) {
    if (e instanceof MediaError) return error(e.message, 400);
    throw e;
  }
}

export function postRestore(req: Request, id: string): Response {
  const user = userFromRequest(req);
  if (!user) return error("Not authenticated", 401);
  try {
    const m = restoreMedia(id);
    return json({ media: mapMedia(m), quota: quotaSnapshot(user.id) });
  } catch (e) {
    if (e instanceof MediaError) return error(e.message, 400);
    throw e;
  }
}

export function postAbort(req: Request, id: string): Response {
  const user = userFromRequest(req);
  if (!user) return error("Not authenticated", 401);
  const ok = abortMedia(id);
  if (!ok) return error("Nothing in progress to abort for that item", 409);
  return json({ ok: true, quota: quotaSnapshot(user.id) });
}

export function postDelete(req: Request, id: string): Response {
  const user = userFromRequest(req);
  if (!user) return error("Not authenticated", 401);
  try {
    deleteMedia(id);
    return json({ ok: true, quota: quotaSnapshot(user.id) });
  } catch (e) {
    if (e instanceof MediaError) return error(e.message, 400);
    throw e;
  }
}
