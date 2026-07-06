// Room client: synchronized playback + unified search + downloads + chat.
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const slug = decodeURIComponent(location.pathname.replace(/^\/r\//, ""));
const player = $<HTMLVideoElement>("player");
const nowPlaying = $("nowPlaying");
const libResults = $("libResults");
const srcResults = $("srcResults");
const dlWrap = $("downloads");
const dlDownloading = $("dlDownloading");
const dlDownloadingList = $("dlDownloadingList");
const dlConverting = $("dlConverting");
const dlConvertingList = $("dlConvertingList");
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
  document.body.dataset.tab = "player";
  const me = await fetch("/api/me");
  if (me.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    return;
  }
  const { user } = await me.json();
  $("who").textContent = `@${user.username}`;
  $("roomId").textContent = `· ${slug}`;
  if (user.isAdmin) $("tabAdmin").removeAttribute("hidden");

  wireControls();
  wireTabs();
  await loadRoomSnapshot();
  connectWS();
}

// --- tabs ---
function wireTabs() {
  for (const btn of document.querySelectorAll<HTMLElement>(".tab")) {
    btn.addEventListener("click", () => showTab(btn.dataset.tab!));
  }
}
function showTab(name: string) {
  for (const btn of document.querySelectorAll<HTMLElement>(".tab")) btn.classList.toggle("active", btn.dataset.tab === name);
  for (const p of document.querySelectorAll<HTMLElement>(".tab-panel")) p.hidden = p.dataset.panel !== name;
  document.body.dataset.tab = name; // CSS shows chat only on the player tab
  if (name === "player") messagesEl.scrollTop = messagesEl.scrollHeight;
  if (name === "friends") loadFriends();
  if (name === "admin") loadAdmin();
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

  let pingTimer: number | undefined;
  ws.onopen = () => {
    wsReady = true;
    // Keepalive so the server's request idle timeout never closes an otherwise-quiet room socket.
    pingTimer = window.setInterval(() => { if (wsReady && ws) ws.send(JSON.stringify({ t: "ping" })); }, 30000);
  };
  ws.onclose = () => { wsReady = false; clearInterval(pingTimer); setTimeout(connectWS, 1500); };
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
      nowPlaying.textContent = "Nothing playing yet — find something in the Download or Library tab.";
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

  $("libSearchBtn").addEventListener("click", runLibrarySearch);
  $<HTMLInputElement>("libQ").addEventListener("keydown", (e) => { if (e.key === "Enter") runLibrarySearch(); });
  $("srcSearchBtn").addEventListener("click", runSourceSearch);
  $<HTMLInputElement>("srcQ").addEventListener("keydown", (e) => { if (e.key === "Enter") runSourceSearch(); });
  $("addFriendBtn").addEventListener("click", addFriend);
  $<HTMLInputElement>("friendName").addEventListener("keydown", (e) => { if (e.key === "Enter") addFriend(); });
  $("newRoom").addEventListener("click", () => { location.href = "/"; });
  $("logout").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    location.href = "/login";
  });
  $("chatSend").addEventListener("click", sendChat);
  $<HTMLInputElement>("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
}

// --- search ---
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

// Library tab — searches your library + archive (fast, local).
let libSeq = 0;
async function runLibrarySearch() {
  const q = $<HTMLInputElement>("libQ").value.trim();
  const seq = ++libSeq;
  const btn = $<HTMLButtonElement>("libSearchBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>`;

  libResults.innerHTML = "";
  const lib = makeSection("In your library");
  const arch = makeSection("In the archive");
  libResults.append(lib.wrap, arch.wrap);
  try {
    const d = await (await fetch(`/api/search?q=${encodeURIComponent(q)}&scope=local`)).json();
    if (seq !== libSeq) return;
    for (const m of [...d.library, ...d.archive]) mediaCache.set(m.id, m);
    fillSection(lib, d.library.map(libraryRow), "Nothing in your library matches.");
    fillSection(arch, d.archive.map(archiveRow), "Nothing in the archive matches.");
  } catch {
    if (seq === libSeq) { noteSection(lib, "Search failed."); noteSection(arch, "Search failed."); }
  } finally {
    if (seq === libSeq) { btn.disabled = false; btn.textContent = "Search"; }
  }
}

// Download tab — searches external sources (can be slow).
let srcSeq = 0;
async function runSourceSearch() {
  const q = $<HTMLInputElement>("srcQ").value.trim();
  if (!q) { srcResults.innerHTML = `<div class="empty">Type something to search sources.</div>`; return; }
  const seq = ++srcSeq;
  const btn = $<HTMLButtonElement>("srcSearchBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>`;

  srcResults.innerHTML = "";
  const placeholder = makeSection("From sources");
  srcResults.append(placeholder.wrap);
  try {
    const d = await (await fetch(`/api/search?q=${encodeURIComponent(q)}&scope=sources`)).json();
    if (seq !== srcSeq) return;
    srcResults.innerHTML = "";
    for (const g of d.sources ?? []) {
      const sec = makeSection(`From ${g.label}`);
      srcResults.appendChild(sec.wrap);
      if (!g.ok) noteSection(sec, `${g.label} is unavailable right now (${g.error ?? "error"}). Try again in a moment.`);
      else fillSection(sec, g.results.map(sourceRow), `No results from ${g.label}.`);
    }
  } catch {
    if (seq === srcSeq) noteSection(placeholder, "Sources are unavailable right now. Try again.");
  } finally {
    if (seq === srcSeq) { btn.disabled = false; btn.textContent = "Search"; }
  }
}

function rowShell(title: string, sub: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "result";
  row.innerHTML = `<div class="meta"><div class="title">${esc(title)}</div><div class="sub">${esc(sub)}</div></div>`;
  return row;
}

function libraryRow(m: Media): HTMLElement {
  const row = rowShell(m.title, fmtSize(m.sizeBytes));
  const play = button("Play", "primary", () => { sendCmd({ type: "LOAD_MEDIA", mediaId: m.id }); showTab("player"); });
  const arch = button("Archive", "", async () => {
    const res = await fetch(`/api/media/${m.id}/archive`, { method: "POST" });
    if (res.ok) runLibrarySearch(); else toast((await res.json()).error ?? "Archive failed");
  });
  row.append(play, arch);
  return row;
}

function archiveRow(m: Media): HTMLElement {
  const row = rowShell(m.title, `archived · ${fmtSize(m.sizeBytes)}`);
  const restore = button("Restore", "primary", async () => {
    const res = await fetch(`/api/media/${m.id}/restore`, { method: "POST" });
    if (res.ok) runLibrarySearch(); else toast((await res.json()).error ?? "Restore failed");
  });
  const del = button("Delete", "danger", async () => {
    if (!confirm(`Permanently delete "${m.title}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/media/${m.id}/delete`, { method: "POST" });
    if (res.ok) runLibrarySearch(); else toast((await res.json()).error ?? "Delete failed");
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
function updateDownloadSections() {
  const dCount = dlDownloadingList.children.length;
  const cCount = dlConvertingList.children.length;
  dlDownloading.style.display = dCount ? "block" : "none";
  dlConverting.style.display = cCount ? "block" : "none";
  dlWrap.style.display = dCount || cCount ? "block" : "none";
}

function removeDownload(mediaId: string) {
  document.getElementById(`dl-${mediaId}`)?.remove();
  updateDownloadSections();
}

async function abortDownload(mediaId: string) {
  const res = await fetch(`/api/media/${mediaId}/abort`, { method: "POST" });
  if (res.ok) removeDownload(mediaId);
  else toast((await res.json()).error ?? "Couldn't cancel");
}

function renderDownload(mediaId: string, title: string, progress: number, phase: "Downloading" | "Converting" = "Downloading") {
  const targetList = phase === "Converting" ? dlConvertingList : dlDownloadingList;
  let el = document.getElementById(`dl-${mediaId}`);
  if (!el) {
    el = document.createElement("div");
    el.className = "dl-item";
    el.id = `dl-${mediaId}`;
    el.innerHTML = `<div class="dl-top"><span class="dl-title"></span><span class="dl-right"><span class="dl-pct"></span><button class="dl-abort" title="Cancel">✕</button></span></div><div class="bar"><span></span></div>`;
    (el.querySelector(".dl-title") as HTMLElement).textContent = title;
    (el.querySelector(".dl-abort") as HTMLElement).addEventListener("click", () => abortDownload(mediaId));
  }
  if (el.parentElement !== targetList) targetList.appendChild(el); // move between Downloading/Converting
  const pct = Math.round(progress * 100);
  el.dataset.pct = String(progress);
  (el.querySelector(".dl-pct") as HTMLElement).textContent = `${pct}%`;
  (el.querySelector(".bar") as HTMLElement).classList.toggle("converting", phase === "Converting");
  (el.querySelector(".bar > span") as HTMLElement).style.width = `${pct}%`;
  sortByProgress(targetList); // most-complete on top
  updateDownloadSections();
}

// Keep a list ordered by progress, descending.
function sortByProgress(list: HTMLElement) {
  const items = [...list.children] as HTMLElement[];
  items.sort((a, b) => Number(b.dataset.pct ?? 0) - Number(a.dataset.pct ?? 0));
  for (const it of items) list.appendChild(it);
}

function onDownloadEvent(ev: any) {
  if (ev.type === "progress") {
    renderDownload(ev.mediaId, ev.title || "Downloading", ev.progress, "Downloading");
  } else if (ev.type === "converting") {
    renderDownload(ev.mediaId, ev.title || "Converting", ev.progress, "Converting");
  } else if (ev.type === "done") {
    removeDownload(ev.mediaId);
    toast("Ready — it's in your Library.");
    runLibrarySearch();
  } else if (ev.type === "failed") {
    removeDownload(ev.mediaId);
    toast(`Failed: ${ev.error ?? "unknown error"}`);
  } else if (ev.type === "aborted") {
    removeDownload(ev.mediaId);
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

// --- friends tab ---
async function loadFriends() {
  const wrap = $("friendsList");
  wrap.innerHTML = `<div class="empty"><span class="spinner"></span>Loading…</div>`;
  try {
    const d = await (await fetch("/api/friends")).json();
    renderFriends(d.friends ?? []);
  } catch {
    wrap.innerHTML = `<div class="empty">Failed to load friends.</div>`;
  }
}

function renderFriends(friends: { id: string; username: string }[]) {
  const wrap = $("friendsList");
  wrap.innerHTML = "";
  if (!friends.length) {
    wrap.innerHTML = `<div class="empty">No friends yet. Add someone by username above.</div>`;
    return;
  }
  const list = document.createElement("div");
  list.className = "results";
  for (const f of friends) {
    const row = rowShell(f.username, "friend");
    row.append(button("Remove", "danger", async () => {
      const res = await fetch(`/api/friends/${f.id}/remove`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) { toast(d.error ?? "Couldn't remove"); return; }
      renderFriends(d.friends);
    }));
    list.appendChild(row);
  }
  wrap.appendChild(list);
}

async function addFriend() {
  const input = $<HTMLInputElement>("friendName");
  const username = input.value.trim();
  if (!username) return;
  const res = await fetch("/api/friends", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username }) });
  const d = await res.json();
  if (!res.ok) { toast(d.error ?? "Couldn't add friend"); return; }
  input.value = "";
  toast(`Added ${username}`);
  renderFriends(d.friends);
}

// --- admin tab ---
function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

async function loadAdmin() {
  const wrap = $("adminUsers");
  wrap.innerHTML = `<div class="empty"><span class="spinner"></span>Loading…</div>`;
  try {
    const res = await fetch("/api/admin/users");
    const d = await res.json();
    if (!res.ok) { wrap.innerHTML = `<div class="empty">${esc(d.error ?? "Failed to load")}</div>`; return; }
    renderAdminUsers(d.users);
  } catch {
    wrap.innerHTML = `<div class="empty">Failed to load users.</div>`;
  }
}

function renderAdminUsers(users: any[]) {
  const wrap = $("adminUsers");
  wrap.innerHTML = "";
  for (const u of users) {
    const card = document.createElement("div");
    card.className = "admin-user";
    card.innerHTML = `
      <div class="admin-head">
        <strong>${esc(u.username)}</strong>
        <label class="admin-adm"><input type="checkbox" class="a-admin" ${u.isAdmin ? "checked" : ""}> admin</label>
      </div>
      <div class="admin-row"><span class="admin-lbl">Active</span><input class="a-storage" type="number" step="0.5" min="0" value="${gib(u.storageQuota)}"><span class="admin-unit">GiB</span><span class="admin-used">${gib(u.storageUsed)} used</span></div>
      <div class="admin-row"><span class="admin-lbl">Archive</span><input class="a-archive" type="number" step="0.5" min="0" value="${gib(u.archiveQuota)}"><span class="admin-unit">GiB</span><span class="admin-used">${gib(u.archiveUsed)} used</span></div>
      <div class="admin-actions"><button class="primary a-save">Save</button><button class="a-reset">Reset to default</button><button class="danger a-delete">Delete user</button></div>`;

    const val = (sel: string) => parseFloat((card.querySelector(sel) as HTMLInputElement).value);
    card.querySelector(".a-save")!.addEventListener("click", async () => {
      const body = {
        storageQuotaBytes: Math.round(val(".a-storage") * 1024 ** 3),
        archiveQuotaBytes: Math.round(val(".a-archive") * 1024 ** 3),
        isAdmin: (card.querySelector(".a-admin") as HTMLInputElement).checked,
      };
      const res = await fetch(`/api/admin/users/${u.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) { toast(d.error ?? "Save failed"); return; }
      let msg = `Saved ${u.username}`;
      if (d.archived) msg += ` · archived ${d.archived}`;
      if (d.purged) msg += ` · deleted ${d.purged}`;
      toast(msg);
      renderAdminUsers(d.users);
    });
    card.querySelector(".a-reset")!.addEventListener("click", async () => {
      const res = await fetch(`/api/admin/users/${u.id}/reset`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) { toast(d.error ?? "Reset failed"); return; }
      toast(`Reset ${u.username} to defaults`);
      renderAdminUsers(d.users);
    });
    card.querySelector(".a-delete")!.addEventListener("click", async () => {
      if (!confirm(`Delete user "${u.username}"? Their media stays in the shared library but is no longer attributed to anyone.`)) return;
      const res = await fetch(`/api/admin/users/${u.id}/delete`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) { toast(d.error ?? "Delete failed"); return; }
      toast(`Deleted ${u.username}`);
      renderAdminUsers(d.users);
    });
    wrap.appendChild(card);
  }
}

init();
