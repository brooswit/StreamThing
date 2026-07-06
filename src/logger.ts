// Minimal tagged logger (brief §15: plain, useful app logs — no monitoring stack).
type Level = "info" | "warn" | "error";

function emit(level: Level, tag: string, msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}`;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (extra !== undefined) sink(line, extra);
  else sink(line);
}

export function logger(tag: string) {
  return {
    info: (msg: string, extra?: unknown) => emit("info", tag, msg, extra),
    warn: (msg: string, extra?: unknown) => emit("warn", tag, msg, extra),
    error: (msg: string, extra?: unknown) => emit("error", tag, msg, extra),
  };
}

export type Logger = ReturnType<typeof logger>;
