// Playwright adapter. Zodchi supplies one frozen scenario and reads its local receipt.
import { readFile, lstat, mkdtemp, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const plan = JSON.parse(await readFile(process.argv[2], "utf8"));
const [scenario, output] = [plan.scenario, plan.output];
const evidence = { status: "blocked", steps: [], frames: [], downloads: [], network: [], console: [], consoleErrors: 0 };
const adapterBlocked = new Set();
let knownSessionValues = [];
let browser;
let page;
let downloadDeadline;
let activity = "validating the product origin";

class Outcome extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function require(condition, message, status = "blocked") {
  if (!condition) throw new Outcome(status, message);
}

function resolvePath(base, relative) {
  require(relative.startsWith("/") && !relative.startsWith("//"), "A request must be a path on the product origin.");
  const url = new URL(relative, base);
  require(url.origin === base.origin && !url.hash && !url.username && !url.password, "A request left the product origin.");
  return url;
}

function pointer(value, key) {
  if (key === "") return value;
  return key.slice(1).split("/").reduce((parent, part) => {
    const field = part.replaceAll("~1", "/").replaceAll("~0", "~");
    return parent && typeof parent === "object" && Object.hasOwn(parent, field) ? parent[field] : undefined;
  }, value);
}

function network(event) {
  if (evidence.network.length < 64) evidence.network.push(event);
}

function diagnosticText(value) {
  if (knownSessionValues.some(secret => value.includes(secret))) return "[source line withheld]";
  return value.length <= 512 ? value : "[diagnostic text exceeds its limit]";
}

function pathname(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return undefined;
    return diagnosticText(decodeURIComponent(url.pathname).split(/[?#]/, 1)[0]);
  } catch {
    return undefined;
  }
}

function consoleError(text, url = "") {
  evidence.consoleErrors++;
  if (evidence.console.length === 64) return;
  const first = String(text).split(/\r?\n/, 1)[0];
  const causedByAdapter = adapterBlocked.has(url) && first.includes("ERR_BLOCKED_BY_CLIENT");
  const message = first.replace(/https?:\/\/[^\s"'<>]+/gi, match => pathname(match) ?? "[URL omitted]");
  evidence.console.push({ message: diagnosticText(message), path: pathname(url), causedByAdapter });
}

function nodePath(value) {
  // The Windows Node module resolver treats namespaced drive paths as package names.
  if (process.platform !== "win32") return value;
  if (value.startsWith("\\\\?\\UNC\\")) return "\\\\" + value.slice(8);
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function number(value, decimal, extract = false) {
  if (typeof value === "number") return value;
  const text = String(value).trim();
  const numericText = extract
    ? text.match(/[+\-\u2212]?[0-9]+(?:[ \u00a0\u202f][0-9]{3}\b)*(?:[.,][0-9]+)*/u)?.[0] ?? ""
    : text;
  if (extract && numericText.includes(decimal === "," ? "." : ",")) return NaN;
  const normalized = numericText.replace(/\s/g, "").replace("\u2212", "-").replace(decimal, ".");
  return /^[+-]?[0-9]+(\.[0-9]+)?$/.test(normalized) ? Number(normalized) : NaN;
}

function cookieForHost(cookie, host) {
  const domain = cookie.domain.toLowerCase();
  return domain.startsWith(".") ? domain.slice(1) === host || host.endsWith(domain) : domain === host;
}

const timeoutOf = step => Math.round((step.maxSeconds ?? 5) * 1000);

async function frame(name) {
  await page.screenshot({ path: path.join(output, name), animations: "disabled", timeout: 5000 });
  evidence.frames.push(name);
}

const asRules = value => Array.isArray(value) ? value : (value ? [value] : []);
const left = deadline => Math.max(1, Math.ceil(deadline - performance.now()));

async function locate(locator) {
  const matches = await locator.count();
  return { matches, visible: matches === 1 && await locator.isVisible() };
}

async function unmet(rules, deadline) {
  const observations = await Promise.all(asRules(rules).map(async rule => {
    const locator = page.locator(rule.selector);
    const state = await locate(locator);
    const expectedCount = rule.count ?? 1;
    const normalize = text => text.replace(/[\s\u00a0]+/gu, " ").trim();
    const textMatched = rule.text === undefined ? null
      : state.visible && (rule.normalizeWhitespace
        ? normalize(await locator.innerText({ timeout: left(deadline) })) === normalize(rule.text)
        : (await locator.innerText({ timeout: left(deadline) })).trim() === rule.text);
    return { selector: rule.selector, ...state, expectedCount, textMatched };
  }));
  return observations.filter(row => row.matches !== row.expectedCount || (row.expectedCount === 1 && !row.visible) || row.textMatched === false);
}

async function ready(expect, record, deadline) {
  while (true) {
    const waiting = await unmet(scenario.ready, deadline);
    const pending = waiting.length ? waiting : await unmet(expect, deadline);
    if (pending.length === 0) return;
    if (performance.now() >= deadline) {
      record.unmet = pending;
      const phase = waiting.length ? "readiness" : "expectations";
      throw new Outcome("fail", `The page did not meet ${phase} within the time limit.`);
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(80, left(deadline))));
  }
}

async function withinDeadline(work, deadline, message, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => { timer = setTimeout(() => { onTimeout(); reject(new Outcome("fail", message)); }, left(deadline)); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function action(base, step, deadline, record) {
  if (step.open !== undefined) {
    const response = await page.goto(resolvePath(base, step.open).href, { waitUntil: "domcontentloaded", timeout: left(deadline) });
    require(response?.ok(), `The page returned HTTP ${response?.status() ?? "unknown"}.`, "fail");
    return;
  }
  const selector = (typeof step.click === "string" ? step.click : step.click?.selector) ?? step.check?.selector ?? step.select?.selector ?? step.fill?.selector ?? step.hover ?? step.press?.selector;
  const target = page.locator(selector);
  try {
    if (step.click !== undefined) {
      const submits = await target.evaluate(element => Boolean(element.closest('button[type="submit"],input[type="submit"],input[type="image"],button:not([type])')?.form), {}, { timeout: left(deadline) });
      require(!submits || plan.managedFixture === true, "The requested click submits a form.");
      const click = typeof step.click === "string" ? {} : step.click;
      if (click.popup) {
        const event = page.waitForEvent("popup", { timeout: left(deadline) }).catch(error => { if (error.name === "TimeoutError") throw new Outcome("fail", "The click did not produce a popup within the time limit."); throw error; });
        const [popup] = await Promise.all([event, target.click({ timeout: left(deadline) })]);
        observePage(popup);
        await popup.waitForLoadState("domcontentloaded", { timeout: left(deadline) }).catch(error => { if (error.name === "TimeoutError") throw new Outcome("fail", "The popup did not load within the time limit."); throw error; });
        require(new URL(popup.url()).origin === base.origin, "The popup left the product origin.", "fail");
        page = popup;
      } else if (click.download) {
        let download;
        downloadDeadline = deadline;
        try {
          const event = page.waitForEvent("download", { timeout: left(deadline) }).catch(error => { if (error.name === "TimeoutError") throw new Outcome("fail", "The click did not produce a download within the time limit."); throw error; });
          [download] = await Promise.all([event, target.click({ timeout: left(deadline) })]);
        } finally { downloadDeadline = undefined; }
        const destination = path.join(output, click.download);
        const exists = await lstat(destination).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
        require(!exists, "The download output already exists.", "fail");
        const staging = await mkdtemp(path.join(output, ".download-"));
        const stagedFile = path.join(staging, "file");
        let timedOut = false;
        const cleanup = () => rm(staging, { recursive: true, force: true }).catch(() => {});
        const saving = (async () => {
          try {
            await download.saveAs(stagedFile);
            const saved = await lstat(stagedFile).catch(() => null);
            require(!(await download.failure()) && saved?.isFile(), "The download failed or did not create a regular output file.", "fail");
          } catch (error) {
            if (error instanceof Outcome) throw error;
            throw new Outcome("fail", "The download failed while saving.");
          } finally {
            if (timedOut) await cleanup();
          }
        })();
        try {
          await withinDeadline(() => saving, deadline, "The download did not complete within the time limit.", () => {
            timedOut = true;
            Promise.resolve().then(() => download.cancel()).catch(() => {});
          });
          if (performance.now() >= deadline) {
            Promise.resolve().then(() => download.cancel()).catch(() => {});
            throw new Outcome("fail", "The download did not complete within the time limit.");
          }
          await rename(stagedFile, destination).catch(() => { throw new Outcome("fail", "The download failed while publishing."); });
        } finally {
          await cleanup();
        }
        evidence.downloads.push(click.download);
      } else await target.click({ timeout: left(deadline) });
    } else if (step.check !== undefined) {
      await target.setChecked(step.check.checked, { timeout: left(deadline) });
    } else if (step.fill !== undefined) {
      await target.fill(step.fill.value, { timeout: left(deadline) });
    } else if (step.hover !== undefined) {
      await target.hover({ timeout: left(deadline) });
    } else if (step.press !== undefined) {
      await target.press(step.press.value, { timeout: left(deadline) });
    } else {
      await target.selectOption({ value: step.select.value }, { timeout: left(deadline) });
    }
  } catch (error) {
    if (!(error instanceof Outcome)) {
      const state = await locate(target).catch(() => null);
      if (state) record.target = { selector, ...state };
      if (state && (error.name === "TimeoutError" || state.matches > 1)) {
        throw new Outcome("fail", `The action locator matched ${state.matches} element(s).`);
      }
    }
    throw error;
  }
}

function observePage(target) {
  target.on("pageerror", error => consoleError(error.message));
  target.on("console", message => {
    if (message.type() === "error") consoleError(message.text(), message.location().url);
  });
}

async function view(base, step, index) {
  const record = { id: step.id, status: "fail", elapsedMs: null };
  evidence.steps.push(record);
  if (step.open === undefined) await frame(`${step.id}-before.png`);
  const began = performance.now();
  const timeout = timeoutOf(step);
  try {
    await action(base, step, began + timeout, record);
  } catch (error) {
    if (error instanceof Outcome) record.error = error.message;
    throw error;
  }
  await ready(step.expect, record, began + timeout);
  record.elapsedMs = Math.round(performance.now() - began);
  require(record.elapsedMs <= timeout, `The view needed ${record.elapsedMs} ms, above the ${timeout} ms limit.`, "fail");
  require(new URL(page.url()).origin === base.origin, "The active page left the product origin.");
  await frame(`${step.id}-after.png`);
  record.status = "pass";
  record.number = index + 1;
}

async function get(context, base, url, maxSeconds = 5) {
  const response = await context.request.get(resolvePath(base, url).href, { maxRedirects: 0, timeout: maxSeconds * 1000 });
  try {
    require(response.ok(), `The evidence endpoint returned HTTP ${response.status()}.`, "fail");
    return await response.json();
  } finally { await response.dispose(); }
}

async function checkHead(context, base) {
  const health = pointer(await get(context, base, plan.health.path), plan.health.pointer);
  require(typeof health === "string" && /^[0-9a-f]{7,64}$/i.test(health) && plan.head.startsWith(health.toLowerCase()),
    "The application reported a different release commit.", "fail");
  return health;
}

try {
  const base = new URL(plan.baseUrl);
  require(!base.username && !base.password && !base.search && !base.hash && base.pathname === "/", "baseUrl must be one product origin.");
  require(base.protocol === "https:" || (base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)),
    "Use HTTPS for the product or HTTP on loopback.");
  if (plan.managedFixture === true) {
    const fixtureOrigin = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]+)$/.exec(plan.baseUrl);
    require(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) &&
      fixtureOrigin && Number(fixtureOrigin[1]) > 0 && Number(fixtureOrigin[1]) <= 65535 &&
      plan.isolation === "headless", "A managed fixture needs a headless loopback origin with an explicit port.");
  }
  activity = "loading Playwright";
  const sdk = createRequire(import.meta.url)(nodePath(plan.module));
  require(sdk.chromium, "The configured Playwright module does not export Chromium.");
  activity = "starting the dedicated Chromium";
  browser = await sdk.chromium.launch({ executablePath: nodePath(plan.executable), headless: plan.isolation === "headless", timeout: 15000 });
  activity = "opening the browser session";
  let storageState;
  if (plan.storageState) {
    const saved = JSON.parse((await readFile(nodePath(plan.storageState), "utf8")).replace(/^\uFEFF/, ""));
    storageState = {
      cookies: saved.cookies.filter(cookie => cookieForHost(cookie, base.hostname)),
      origins: saved.origins.filter(origin => origin.origin === base.origin),
    };
    knownSessionValues = storageState.cookies.map(cookie => cookie.value).filter(value => value.length >= 8);
  }
  const context = await browser.newContext({ storageState, serviceWorkers: "block", acceptDownloads: plan.managedFixture === true, viewport: { width: 1280, height: 800 } });
  require(typeof context.routeWebSocket === "function", "Playwright 1.48 or later is required for read-only browser routing.");
  await context.routeWebSocket(/.*/, socket => { network({ kind: "blocked websocket", path: pathname(socket.url()) }); return socket.close(); });
  await context.route(/.*/, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const same = url.origin === base.origin;
    const method = request.method();
    const info = { method, sameOrigin: same, path: pathname(url.href) };
    const block = () => {
      if (adapterBlocked.size < 128) adapterBlocked.add(url.href);
      return route.abort("blockedbyclient");
    };
    const allowedWrite = plan.managedFixture === true && (plan.allowedWrites ?? []).some(entry => entry.method === method && entry.path === url.pathname);
    if (!same || (!["GET", "HEAD"].includes(method) && !allowedWrite)) {
      network({ kind: "blocked request", ...info });
      return block();
    }
    try {
      // Resolve the request here to gate redirects before any destination receives a request.
      const response = await route.fetch({ maxRedirects: 0, timeout: downloadDeadline === undefined ? 15000 : left(downloadDeadline) });
      try {
        if (response.status() >= 300 && response.status() < 400 && response.status() !== 304) {
          network({ kind: "blocked redirect", ...info, status: response.status() });
          return await block();
        }
        if (response.status() >= 400) network({ kind: "http error", ...info, status: response.status() });
        await route.fulfill({ response });
      } finally { await response.dispose(); }
    } catch {
      network({ kind: "request failed", ...info });
      await route.abort().catch(() => {});
    }
  });

  if (plan.managedFixture !== true) {
    activity = "checking the deployed commit";
    evidence.healthBefore = await checkHead(context, base);
  }
  page = await context.newPage();
  observePage(page);
  for (const [index, step] of scenario.steps.entries()) {
    activity = `running step ${step.id}`;
    await view(base, step, index);
  }
  if (scenario.apiCheck) {
    activity = "comparing the display and API";
    const check = scenario.apiCheck;
    const comparison = { matches: null, visible: false, text: null, ui: null, api: null, difference: null, tolerance: check.tolerance ?? 0 };
    evidence.apiCheck = comparison;
    const deadline = performance.now() + 5000;
    await ready([], comparison, deadline);
    const locator = page.locator(check.selector);
    Object.assign(comparison, await locate(locator));
    require(comparison.visible, "The amount selector must match exactly one visible element.", "fail");
    const display = await locator.innerText({ timeout: left(deadline) });
    comparison.text = diagnosticText(display);
    const webValue = number(display, check.decimal ?? ".", check.extract === "first-number");
    const apiValue = number(pointer(await get(context, base, check.path), check.pointer), check.decimal ?? ".");
    const difference = Number.isFinite(webValue) && Number.isFinite(apiValue) ? Math.abs(webValue - apiValue) : null;
    Object.assign(comparison, { ui: webValue, api: apiValue, difference });
    require(difference !== null && difference <= comparison.tolerance, "The displayed number differs from the API for these filters.", "fail");
  }
  if (plan.managedFixture !== true) {
    activity = "rechecking the deployed commit";
    evidence.healthAfter = await checkHead(context, base);
  }
  evidence.status = "pass";
} catch (error) {
  evidence.status = error instanceof Outcome ? error.status : (error.name === "TimeoutError" && page ? "fail" : "blocked");
  evidence.error = error instanceof Outcome ? error.message : `${error.name || "Browser error"} while ${activity}.`;
  if (page) await frame("failure.png").catch(() => {});
  // The error may contain auth headers, URLs with query material, or DOM data. Keep only the bounded summary.
} finally {
  if (browser) await browser.close().catch(() => {});
  process.stdout.write(JSON.stringify(evidence) + "\n");
}
