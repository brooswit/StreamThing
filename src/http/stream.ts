// Range-capable media streaming for the <video> element (seek support).
import { getMedia } from "../media/index.ts";
import { userFromRequest } from "../auth/index.ts";

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  ogv: "video/ogg",
  ogg: "video/ogg",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
};

function contentType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export async function streamMedia(req: Request, mediaId: string): Promise<Response> {
  if (!userFromRequest(req)) return new Response("Unauthorized", { status: 401 });

  const media = getMedia(mediaId);
  if (!media || !media.file_path) return new Response("Not found", { status: 404 });
  if (media.state !== "available" && media.state !== "archived") {
    return new Response("Media not playable", { status: 409 });
  }

  const file = Bun.file(media.file_path);
  if (!(await file.exists())) return new Response("File missing", { status: 404 });

  const size = file.size;
  const type = contentType(media.file_path);
  const range = req.headers.get("range");

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m?.[1] ? parseInt(m[1], 10) : 0;
    let end = m?.[2] ? parseInt(m[2], 10) : size - 1;
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= size) end = size - 1;
    if (start > end || start >= size) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Type": type,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(file, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Content-Length": String(size),
      "Cache-Control": "no-store",
    },
  });
}
