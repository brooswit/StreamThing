// Room client: synchronized playback + unified search + downloads + chat.
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const slug = decodeURIComponent(location.pathname.replace(/^\/r\//, ""));
const player = $<HTMLVideoElement>("player");
const nowPlaying = $("nowPlaying");
const results = $("searchResults");
const dlWrap = $("downloads");
const dlList = $("dlList");
const messagesEl = $("messages");
const presenceEl = $("presence");

type Media = { id: string; title: string; state: string; sizeBytes: number; streamUrl: string | null };
type RoomState = { roomId: string; mediaId: string | null; status: "idle" | "playing" | "paused"; positionSeconds: number; updatedAt: number };

const mediaCache = new Map<string, Media>();
let currentMediaId: string | null = null;
let lastState: RoomState | null = null;
let suppressUntil = 0;
let ws: WebSocket | null = null;
let wsReady = false;

// --- helpers ---
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
function fmtSize(bytes: number): string {
  if (!bytes) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
let toastTimer: number | undefined;
function toast(text: string) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 3500);
}
function withSuppress(fn: () => void) {
  suppressUntil = Date.now() + 500;
  fn();
}
function suppressed(): boolean {
  return Date.now() < suppressUntil;
}

// --- boot ---
async function init() {
  document.body.classList.add("room");
  const me = await fetch("/api/me");
  if (me.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    return;
  }
  const { user } = await me.json();
  $("who").textContent = `@${user.username}`;
  $("roomId").textContent = `· ${slug}`;

  wireControls();
  await loadRoomSnapshot();
  connectWS();
}

async function loadRoomSnapshot() {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(slug)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.currentMedia) mediaCache.set(data.currentMedia.id, data.currentMedia);
    for (const m of data.downloading ?? []) renderDownload(m.id, m.title, 0, m.state === "converting" ? "Converting" : "Downloading");
  } catch { /* ignore */ }
}

// --- WebSocket ---
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(slug)}`);

  ws.onopen = () => { wsReady = true; };
  ws.onclose = () => { wsReady = false; setTimeout(connectWS, 1500); };
  ws.onmessage = (ev) => {
    let msg: any;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.t) {
      case "state": applyState(msg.state); break;
      case "chat": appendMessage(msg.msg); break;
      case "chat_history": renderHistory(msg.messages); break;
      case "download": onDownloadEvent(msg.ev); break;
      case "presence": presenceEl.textContent = msg.count > 0 ? `${msg.count} watching` : ""; break;
      case "error": toast(msg.message); break;
    }
  };
}
function sendCmd(cmd: object) {
  if (wsReady && ws) ws.send(JSON.stringify({ t: "cmd", cmd }));
}

// --- playback sync ---
async function resolveMedia(id: string): Promise<Media | null> {
  if (mediaCache.has(id)) return mediaCache.get(id)!;
  try {
    const res = await fetch(`/api/media/${id}`);
    if (!res.ok) return null;
    const { media } = await res.json();
    mediaCache.set(id, media);
    return media;
  } catch { return null; }
}

async function applyState(state: RoomState) {
  lastState = state;
  if (state.mediaId !== currentMediaId) {
    currentMediaId = state.mediaId;
    if (state.mediaId) {
      const info = await resolveMedia(state.mediaId);
      if (info?.streamUrl) {
        withSuppress(() => { player.src = info.streamUrl!; player.load(); });
        nowPlaying.innerHTML = `<strong>${esc(info.title)}</strong>`;
      }
    } else {
      withSuppress(() => { player.removeAttribute("src"); player.load(); });
      nowPlaying.textContent = "Nothing playing yet — search below to start.";
    }
  }
  syncPlayback(state);
}

function targetPosition(state: RoomState): number {
  return state.status === "playing"
    ? state.positionSeconds + (Date.now() - state.updatedAt) / 1000
    : state.positionSeconds;
}

function syncPlayback(state: RoomState) {
  if (player.readyState < 1) {
    // Metadata not ready yet — apply once it is.
    player.addEventListener("loadedmetadata", () => syncPlayback(state), { once: true });
    return;
  }
  const target = targetPosition(state);
  if (Number.isFinite(target) && Math.abs(player.currentTime - target) > 1.5) {
    withSuppress(() => { player.currentTime = Math.max(0, target); });
  }
  if (state.status === "playing" && player.paused) withSuppress(() => player.play().catch(() => {}));
  if (state.status === "paused" && !player.paused) withSuppress(() => player.pause());
}

// Nudge back onto the authoritative timeline periodically (covers drift between commands).
setInterval(() => {
  if (lastState?.status === "playing" && !player.paused && player.readyState >= 1) {
    const target = targetPosition(lastState);
    if (Math.abs(player.currentTime - target) > 2) withSuppress(() => { player.currentTime = Math.max(0, target); });
  }
}, 4000);

function wireControls() {
  player.addEventListener("play", () => { if (!suppressed() && currentMediaId) sendCmd({ type: "PLAY", positionSeconds: player.currentTime }); });
  player.addEventListener("pause", () => { if (!suppressed() && currentMediaId) sendCmd({ type: "PAUSE", positionSeconds: player.currentTime }); });
  player.addEventListener("seeked", () => { if (!suppressed() && currentMediaId) sendCmd({ type: "SEEK", positionSeconds: player.currentTime }); });

  $("searchBtn").addEventListener("click", runSearch);
  $<HTMLInputElement>("q").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
  $("newRoom").addEventListener("click", () => { location.href = "/"; });
  $("logout").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    location.href = "/login";
  });
  $("chatSend").addEventListener("click", sendChat);
  $<HTMLInputElement>("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
}

// --- search (progressive: local results instantly, external sources when they arrive) ---
let searchSeq = 0;

type Section = { wrap: HTMLElement; header: HTMLElement; body: HTMLElement; title: string };
function makeSection(title: string): Section {
  const wrap = document.createElement("div");
  const header = document.createElement("div");
  header.className = "section-title";
  header.textContent = title;
  const body = document.createElement("div");
  body.className = "results";
  body.innerHTML = `<div class="empty"><span class="spinner"></span>Searching…</div>`;
  wrap.append(header, body);
  return { wrap, header, body, title };
}
function fillSection(sec: Section, rows: HTMLElement[], emptyMsg: string) {
  sec.header.textContent = `${sec.title} (${rows.length})`;
  sec.body.innerHTML = "";
  if (!rows.length) sec.body.innerHTML = `<div class="empty">${esc(emptyMsg)}</div>`;
  else for (const r of rows) sec.body.appendChild(r);
}
function noteSection(sec: Section, msg: string) {
  sec.header.textContent = sec.title;
  sec.body.innerHTML = `<div class="empty">${esc(msg)}</div>`;
}

async function runSearch() {
  const q = $<HTMLInputElement>("q").value.trim();
  const seq = ++searchSeq;
  const enc = encodeURIComponent(q);

  const btn = $<HTMLButtonElement>("searchBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>`;

  results.innerHTML = "";
  const lib = makeSection("In your library");
  const arch = makeSection("In the archive");
  const srcPlaceholder = makeSection("From sources");
  results.append(lib.wrap, arch.wrap, srcPlaceholder.wrap);

  // Local library + archive — instant.
  const localDone = fetch(`/api/search?q=${enc}&scope=local`)
    .then((r) => r.json())
    .then((d) => {
      if (seq !== searchSeq) return;
      for (const m of [...d.library, ...d.archive]) mediaCache.set(m.id, m);
      fillSection(lib, d.library.map(libraryRow), "Nothing in your library matches.");
      fillSection(arch, d.archive.map(archiveRow), "Nothing in the archive matches.");
    })
    .catch(() => {
      if (seq !== searchSeq) return;
      noteSection(lib, "Search failed.");
      noteSection(arch, "Search failed.");
    });

  // External sources — can be slow; replace the placeholder with one section per source.
  const sourcesDone = fetch(`/api/search?q=${enc}&scope=sources`)
    .then((r) => r.json())
    .then((d) => {
      if (seq !== searchSeq) return;
      srcPlaceholder.wrap.remove();
      for (const g of d.sources ?? []) {
        const sec = makeSection(`From ${g.label}`);
        results.appendChild(sec.wrap);
        if (!g.ok) noteSection(sec, `${g.label} is unavailable right now (${g.error ?? "error"}). Try again in a moment.`);
        else fillSection(sec, g.results.map(sourceRow), `No results from ${g.label}.`);
      }
    })
    .catch(() => {
      if (seq === searchSeq) noteSection(srcPlaceholder, "Sources are unavailable right now. Try again.");
    });

  // Restore the button once both requests settle (unless a newer search superseded this one).
  Promise.allSettled([localDone, sourcesDone]).then(() => {
    if (seq !== searchSeq) return;
    btn.disabled = false;
    btn.textContent = "Search";
  });
}

function rowShell(title: string, sub: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "result";
  row.innerHTML = `<div class="meta"><div class="title">${esc(title)}</div><div class="sub">${esc(sub)}</div></div>`;
  return row;
}

function libraryRow(m: Media): HTMLElement {
  const row = rowShell(m.title, fmtSize(m.sizeBytes));
  const play = button("Play", "primary", () => sendCmd({ type: "LOAD_MEDIA", mediaId: m.id }));
  const arch = button("Archive", "", async () => {
    const res = await fetch(`/api/media/${m.id}/archive`, { method: "POST" });
    if (res.ok) runSearch(); else toast((await res.json()).error ?? "Archive failed");
  });
  row.append(play, arch);
  return row;
}

function archiveRow(m: Media): HTMLElement {
  const row = rowShell(m.title, `archived · ${fmtSize(m.sizeBytes)}`);
  const restore = button("Restore", "primary", async () => {
    const res = await fetch(`/api/media/${m.id}/restore`, { method: "POST" });
    if (res.ok) runSearch(); else toast((await res.json()).error ?? "Restore failed");
  });
  const del = button("Delete", "danger", async () => {
    if (!confirm(`Permanently delete "${m.title}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/media/${m.id}/delete`, { method: "POST" });
    if (res.ok) runSearch(); else toast((await res.json()).error ?? "Delete failed");
  });
  row.append(restore, del);
  return row;
}

function sourceRow(r: any): HTMLElement {
  const row = rowShell(r.title, r.subtitle ?? "");
  const dl = button("Download", "primary", async () => {
    dl.disabled = true;
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: r.source, externalId: r.externalId, magnet: r.magnet, title: r.title, sizeBytes: r.sizeBytes, roomId: slug }),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error ?? "Download failed"); dl.disabled = false; return; }
    renderDownload(data.media.id, data.media.title, 0);
    dl.textContent = "Downloading…";
  });
  row.append(dl);
  return row;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}

// --- downloads strip ---
function renderDownload(mediaId: string, title: string, progress: number, phase = "Downloading") {
  dlWrap.style.display = "block";
  let el = document.getElementById(`dl-${mediaId}`);
  if (!el) {
    el = document.createElement("div");
    el.className = "dl-item";
    el.id = `dl-${mediaId}`;
    el.innerHTML = `<div class="dl-top"><span class="dl-title"></span><span class="dl-pct"></span></div><div class="bar"><span></span></div>`;
    (el.querySelector(".dl-title") as HTMLElement).textContent = title;
    dlList.appendChild(el);
  }
  const pct = Math.round(progress * 100);
  (el.querySelector(".dl-pct") as HTMLElement).textContent = `${phase} ${pct}%`;
  (el.querySelector(".bar") as HTMLElement).classList.toggle("converting", phase === "Converting");
  (el.querySelector(".bar > span") as HTMLElement).style.width = `${pct}%`;
}

function onDownloadEvent(ev: any) {
  if (ev.type === "progress") {
    renderDownload(ev.mediaId, mediaCache.get(ev.mediaId)?.title ?? "Downloading", ev.progress, "Downloading");
  } else if (ev.type === "converting") {
    renderDownload(ev.mediaId, mediaCache.get(ev.mediaId)?.title ?? "Converting", ev.progress, "Converting");
  } else if (ev.type === "done") {
    renderDownload(ev.mediaId, mediaCache.get(ev.mediaId)?.title ?? "Ready", 1);
    setTimeout(() => { document.getElementById(`dl-${ev.mediaId}`)?.remove(); if (!dlList.children.length) dlWrap.style.display = "none"; }, 1500);
    toast("Download ready — search to play it.");
    runSearch();
  } else if (ev.type === "failed") {
    document.getElementById(`dl-${ev.mediaId}`)?.remove();
    if (!dlList.children.length) dlWrap.style.display = "none";
    toast(`Download failed: ${ev.error ?? "unknown error"}`);
  }
}

// --- chat ---
function sendChat() {
  const input = $<HTMLInputElement>("chatInput");
  const body = input.value.trim();
  if (!body || !wsReady || !ws) return;
  ws.send(JSON.stringify({ t: "chat", body }));
  input.value = "";
}
function renderHistory(msgs: any[]) {
  messagesEl.innerHTML = "";
  for (const m of msgs) appendMessage(m, false);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function appendMessage(m: any, scroll = true) {
  const el = document.createElement("div");
  el.className = "message";
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  el.innerHTML = `<span class="from">${esc(m.username)}</span><span class="time">${time}</span><div class="body">${esc(m.body)}</div>`;
  messagesEl.appendChild(el);
  if (scroll) messagesEl.scrollTop = messagesEl.scrollHeight;
}

init();
