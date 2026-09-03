import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";

const SCREENSHOT_MARKER = Object.freeze({
  left: 40,
  top: 160,
  cellSize: 24,
  columns: 8,
  rows: 8,
  colors: Object.freeze([[11, 94, 215], [255, 167, 38]])
});

export function browserScreenshotMarker(resourceToken) {
  const digest = crypto.createHash("sha256").update(resourceToken).digest();
  const bits = Array.from({ length: SCREENSHOT_MARKER.columns * SCREENSHOT_MARKER.rows }, (_, index) => (digest[Math.floor(index / 8)] >> (7 - (index % 8))) & 1);
  return { ...SCREENSHOT_MARKER, colors: SCREENSHOT_MARKER.colors.map(color => [...color]), bits, sha256: crypto.createHash("sha256").update(Buffer.from(bits)).digest("hex") };
}

function screenshotMarkerHtml(marker) {
  const cells = marker.bits.map((bit, index) => `<i data-cell="${index}" style="display:block;background:rgb(${marker.colors[bit].join(",")})"></i>`).join("");
  return `<section id="zodchi-proof-marker" aria-label="Random screenshot proof" data-bits="${marker.bits.join("")}" style="position:absolute;left:${marker.left}px;top:${marker.top}px;display:grid;grid-template-columns:repeat(${marker.columns},${marker.cellSize}px);grid-template-rows:repeat(${marker.rows},${marker.cellSize}px);width:${marker.columns * marker.cellSize}px;height:${marker.rows * marker.cellSize}px">${cells}</section>`;
}

export async function startBrowserSentinel({ route, title, body, requestLog, resourceToken }) {
  const screenshotMarker = browserScreenshotMarker(resourceToken);
  const markerHtml = screenshotMarkerHtml(screenshotMarker);
  const source = `
const http = require("node:http");
const fs = require("node:fs");
const [route, title, body, requestLog, resourceToken, markerHtml] = process.argv.slice(1);
const scriptRoute = route + "/runtime-" + resourceToken + ".js";
const imageRoute = route + "/pixel-" + resourceToken + ".png";
const beaconRoute = route + "/executed-" + resourceToken;
const server = http.createServer((request, response) => {
  fs.appendFileSync(requestLog, JSON.stringify({
    method: request.method,
    url: request.url,
    user_agent: request.headers["user-agent"] || null,
    sec_fetch_mode: request.headers["sec-fetch-mode"] || null,
    sec_fetch_dest: request.headers["sec-fetch-dest"] || null,
    referer: request.headers.referer || null
  }) + "\\n");
  response.setHeader("Cache-Control", "no-store");
  if (request.url === route) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>" + title + "</title><style>html,body{margin:0;background:#fff;color:#071c4d;font:32px sans-serif}main{padding:48px 40px}</style><main>" + body + "</main>" + markerHtml + "<img alt='' style='position:absolute;left:0;top:0;width:1px;height:1px' src='" + imageRoute + "'><script src='" + scriptRoute + "'></script>");
    return;
  }
  if (request.url === scriptRoute) {
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.end("fetch(" + JSON.stringify(beaconRoute) + ", { cache: 'no-store' }).catch(() => {});");
    return;
  }
  if (request.url === imageRoute) {
    response.setHeader("Content-Type", "image/png");
    response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    return;
  }
  if (request.url === beaconRoute) { response.statusCode = 204; response.end(); return; }
  response.statusCode = 404; response.end("not found");
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
`;
  const child = spawn(process.execPath, ["-e", source, route, title, body, requestLog, resourceToken, markerHtml], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const port = await new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`BROWSER_SMOKE_SERVER_TIMEOUT: ${stderr}`)); }, 10_000);
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
      const line = stdout.split(/\r?\n/u)[0];
      if (!/^\d+$/u.test(line)) return;
      clearTimeout(timeout); resolve(Number(line));
    });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { if (!stdout.includes("\n")) { clearTimeout(timeout); reject(new Error(`BROWSER_SMOKE_SERVER_EXIT: ${code}: ${stderr}`)); } });
  });
  return {
    child,
    url: `http://127.0.0.1:${port}${route}`,
    screenshotMarker,
    routes: {
      document: route,
      script: `${route}/runtime-${resourceToken}.js`,
      image: `${route}/pixel-${resourceToken}.png`,
      beacon: `${route}/executed-${resourceToken}`
    }
  };
}

export function readBrowserSentinelEvidence(file, routes) {
  const requests = fs.statSync(file, { throwIfNoEntry: false })?.isFile()
    ? fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    : [];
  const browserAgent = /(?:Chrome|Chromium|Edg|Firefox|Safari)\//u;
  const observed = kind => requests.find(item => item.url === routes[kind]);
  const document = observed("document"), script = observed("script"), image = observed("image"), beacon = observed("beacon");
  const userAgent = document?.user_agent ?? null;
  const confirmed = Boolean(
    document && script && image && beacon && browserAgent.test(userAgent ?? "") &&
    document.sec_fetch_mode === "navigate" && document.sec_fetch_dest === "document" &&
    script.sec_fetch_dest === "script" && image.sec_fetch_dest === "image" &&
    [script, image, beacon].every(item => item.user_agent === userAgent)
  );
  return { confirmed, user_agent: userAgent, requests };
}
