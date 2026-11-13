// Minimal static file server for e2e tests — deliberately not `wrangler dev`.
// These tests exercise public/index.html's own JS/CSS with every network call
// mocked via Playwright route interception (see dashboard.spec.ts), so they need
// nothing more than the raw file served from disk; no Worker code runs, and no
// Todoist/Cloudflare credentials are needed, which keeps this runnable in CI with
// zero secrets. Using Node's built-in http module rather than adding a "serve"
// package keeps this project's zero-runtime-dependency stance (see CLAUDE.md) —
// this is dev/test tooling, not shipped code, but there's no reason to reach for a
// dependency for something this small either way.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const PORT = Number(process.env.PORT || 8788);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const path = normalize(req.url.split("?")[0]);
  const filePath = path === "/" ? join(PUBLIC_DIR, "index.html") : join(PUBLIC_DIR, path);

  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`static server for e2e tests listening on http://localhost:${PORT}`);
});
