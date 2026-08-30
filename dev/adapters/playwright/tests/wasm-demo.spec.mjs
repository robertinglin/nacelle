import { expect, test } from "playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const adapterRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
let localServer = null;
let serverUrl = "";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
};

test.beforeAll(async () => {
  localServer = createServer(async (req, res) => {
    try {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Access-Control-Allow-Origin", "*");

      let pathname = new URL(req.url, "http://localhost").pathname || "/";
      if (pathname === "/" || pathname === "/wasm-demo.html") {
        const data = await readFile(path.resolve(adapterRoot, "wasm-demo.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(data);
        return;
      }

      const safeRelative = pathname.replace(/^\/+/, "");
      const filePath = path.resolve(adapterRoot, safeRelative);
      if (!filePath.startsWith(adapterRoot)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      const ext = path.extname(filePath);
      const data = await readFile(filePath);
      res.writeHead(200, {
        "Content-Type": mimeTypes[ext] || "application/octet-stream",
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found: " + req.url);
    }
  });

  await new Promise((resolve) => localServer.listen(0, "127.0.0.1", resolve));
  const port = localServer.address().port;
  serverUrl = `http://127.0.0.1:${port}/wasm-demo.html`;
});

test.afterAll(async () => {
  if (localServer) {
    await new Promise((resolve) => localServer.close(resolve));
  }
});

test("wasm-demo.html loads and verifies all 14 WebAssembly modules in browser", async ({ page }) => {
  const browserLogs = [];
  page.on("console", (msg) => browserLogs.push(msg.text()));

  await page.goto(serverUrl);
  await expect(page.locator("header .brand")).toContainText("Browser Node Harness");
  await expect(page.locator("#manifest-info")).toContainText("Node v22 Manifest");

  // Verify all 14 probes achieve "Ready (200 OK)"
  const probes = [
    "sqlite",
    "better-sqlite3",
    "sqlite3",
    "zlib",
    "brotli",
    "zstd",
    "llhttp",
    "nghttp2",
    "simdutf",
    "ada",
    "cares",
    "uvwasi",
    "bcrypt",
    "napi",
  ];

  for (const probe of probes) {
    const statusEl = page.locator(`#status-${probe}`);
    await expect(statusEl).toHaveText("Ready (200 OK)", { timeout: 10000 });
  }

  // Double-check specific outputs
  const sqliteOut = await page.locator("#sqlite-output").textContent();
  expect(sqliteOut).toContain("sqlite.wasm Loaded & Verified");

  const napiOut = await page.locator("#napi-output").textContent();
  expect(napiOut).toContain("addon.add(40, 2) => 42");

  const bcryptOut = await page.locator("#bcrypt-output").textContent();
  expect(bcryptOut).toContain("bcrypt.wasm Loaded via N-API");
});
