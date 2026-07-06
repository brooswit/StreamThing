// Login / create-account page logic.
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const username = $<HTMLInputElement>("username");
const password = $<HTMLInputElement>("password");
const loginBtn = $<HTMLButtonElement>("login");
const registerBtn = $<HTMLButtonElement>("register");
const msg = $<HTMLDivElement>("msg");

function nextUrl(): string {
  const p = new URLSearchParams(location.search).get("next");
  return p && p.startsWith("/") ? p : "/";
}

function show(text: string, kind: "err" | "ok" = "err") {
  msg.textContent = text;
  msg.className = `msg ${kind}`;
}

async function submit(path: string) {
  const u = username.value.trim();
  const p = password.value;
  if (!u || !p) return show("Enter a username and password.");
  loginBtn.disabled = registerBtn.disabled = true;
  show("");
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p }),
    });
    const data = await res.json();
    if (!res.ok) {
      show(data.error ?? "Something went wrong.");
      return;
    }
    location.href = nextUrl();
  } catch {
    show("Network error — is the server running?");
  } finally {
    loginBtn.disabled = registerBtn.disabled = false;
  }
}

loginBtn.addEventListener("click", () => submit("/api/auth/login"));
registerBtn.addEventListener("click", () => submit("/api/auth/register"));
password.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submit("/api/auth/login");
});

// Hide the register button if registration is closed.
fetch("/api/config")
  .then((r) => r.json())
  .then((c) => {
    if (!c.allowRegistration) registerBtn.style.display = "none";
  })
  .catch(() => {});
