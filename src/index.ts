// StreamThing entrypoint: one Bun server for HTTP API, static frontend, and room WebSockets.
import type { BunRequest, Server } from "bun";
import { config } from "./config.ts";
import { logger } from "./logger.ts";
import "./db/index.ts"; // opens DB + runs migrations
import { userFromRequest } from "./auth/index.ts";
import { generateSlug } from "./rooms/index.ts";
import { resumeDownloads, shutdown } from "./downloads/index.ts";
import { setServer, upgrade, websocket } from "./ws/index.ts";
import { streamMedia } from "./http/stream.ts";
import * as api from "./http/api.ts";

// Frontend HTML — Bun bundles the referenced .ts/.css at runtime (no build step).
import indexPage from "../web/index.html";
import loginPage from "../web/login.html";

const log = logger("server");

function rootRedirect(req: Request): Response {
  const dest = userFromRequest(req) ? `/r/${generateSlug()}` : "/login";
  return Response.redirect(dest, 302);
}

const server: Server = Bun.serve({
  port: config.port,
  development: process.env.NODE_ENV !== "production",
  // Bun's default request idleTimeout is 10s, which severs slow source searches (apibay often takes
  // ~20s). Raise it so those requests can complete. (Room WebSockets are kept alive by client pings.)
  idleTimeout: 90,

  routes: {
    "/": rootRedirect,
    "/login": loginPage,
    "/r/:slug": indexPage,

    // Stylesheet served with no-cache so edits show on a normal refresh. (Bun's dev asset pipeline
    // keeps a stable /_bun/asset URL even when the CSS changes, so the browser caches it stale.)
    "/styles.css": () =>
      new Response(Bun.file("web/app.css"), {
        headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" },
      }),

    "/ws": (req: BunRequest, srv: Server) => upgrade(req, srv) ?? new Response(null),

    "/api/config": { GET: () => api.getConfig() },
    "/api/me": { GET: (req: BunRequest) => api.getMe(req) },
    "/api/auth/register": { POST: (req: BunRequest) => api.postRegister(req) },
    "/api/auth/login": { POST: (req: BunRequest) => api.postLogin(req) },
    "/api/auth/logout": { POST: (req: BunRequest) => api.postLogout(req) },
    "/api/rooms/:slug": { GET: (req: BunRequest<"/api/rooms/:slug">) => api.getRoom(req, req.params.slug) },
    "/api/search": { GET: (req: BunRequest) => api.getSearch(req) },
    "/api/download": { POST: (req: BunRequest) => api.postDownload(req) },
    "/api/media/:id": { GET: (req: BunRequest<"/api/media/:id">) => api.getMediaOne(req, req.params.id) },
    "/api/media/:id/archive": { POST: (req: BunRequest<"/api/media/:id/archive">) => api.postArchive(req, req.params.id) },
    "/api/media/:id/restore": { POST: (req: BunRequest<"/api/media/:id/restore">) => api.postRestore(req, req.params.id) },
    "/api/media/:id/delete": { POST: (req: BunRequest<"/api/media/:id/delete">) => api.postDelete(req, req.params.id) },
    "/api/media/:id/abort": { POST: (req: BunRequest<"/api/media/:id/abort">) => api.postAbort(req, req.params.id) },
    "/api/media/:id/stream": { GET: (req: BunRequest<"/api/media/:id/stream">) => streamMedia(req, req.params.id) },
  },

  fetch() {
    return new Response("Not found", { status: 404 });
  },

  websocket,

  error(err) {
    log.error("unhandled request error", err.message);
    return new Response("Internal error", { status: 500 });
  },
});

setServer(server);
resumeDownloads();

log.info(`StreamThing listening on http://localhost:${server.port}`);
log.info(`data dir: ${config.dataDir} · registration: ${config.allowRegistration ? "open" : "closed"}`);

async function stop(signal: string) {
  log.info(`received ${signal}, shutting down…`);
  await shutdown();
  process.exit(0);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
