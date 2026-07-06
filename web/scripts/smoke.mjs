// Real-browser smoke test: serves dist/, uploads a wav, waits for the
// engraved score. Run: node scripts/smoke.mjs [--effort ultra] [path/to.wav]
// Requires google-chrome or chromium on the PATH.

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const CHROME_CANDIDATES = ["/usr/bin/google-chrome", "/snap/bin/chromium", "/usr/bin/chromium"];
const chrome = CHROME_CANDIDATES.find(existsSync);
if (!chrome) {
  console.error("no chrome/chromium found");
  process.exit(1);
}

const args = process.argv.slice(2);
const effortFlag = args.indexOf("--effort");
const effort = effortFlag >= 0 ? args[effortFlag + 1] : "ultra";
const wav = args.find((a) => a.endsWith(".wav"));
if (!wav || !existsSync(wav)) {
  console.error("usage: node scripts/smoke.mjs [--effort ultra] path/to.wav");
  process.exit(1);
}

const EFFORT_INDEX = { ultra: 0, fast: 1, balanced: 2, best: 3 };
const TIMEOUT_MS = effort === "ultra" ? 90_000 : 600_000;

// serve dist/ (vite preview)
const server = spawn("npx", ["vite", "preview", "--port", "4179", "--strictPort"], {
  stdio: "pipe",
});
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => d.toString().includes("4179") && resolve());
  server.stderr.on("data", (d) => process.stderr.write(d));
  setTimeout(() => reject(new Error("preview server did not start")), 15000);
});

let failed = false;
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});
try {
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[console]", m.text());
  });
  page.on("pageerror", (e) => {
    failed = true;
    console.error("[pageerror]", e.message);
  });

  await page.goto("http://localhost:4179/", { waitUntil: "networkidle2" });
  await page.waitForSelector(".segmented button");

  // pick the effort, then upload the wav
  await page.evaluate((idx) => {
    document.querySelectorAll(".segmented button")[idx].click();
  }, EFFORT_INDEX[effort]);
  const input = await page.waitForSelector("input[type=file]");
  await input.uploadFile(wav);

  console.log(`uploaded ${wav} at effort=${effort}, waiting for the score…`);
  await page.waitForSelector(".pages .page svg", { timeout: TIMEOUT_MS });

  const stats = await page.evaluate(() => ({
    pages: document.querySelectorAll(".pages .page svg").length,
    chips: [...document.querySelectorAll(".chip")].map((c) => c.textContent.trim()),
    noteheads: document.querySelectorAll(".pages .page svg .note").length,
  }));
  console.log("score rendered:", JSON.stringify(stats));
  if (!stats.pages || !stats.noteheads) {
    failed = true;
    console.error("no pages or no noteheads rendered");
  }

  // PDF export: click the button and verify a non-trivial PDF blob comes out
  const pdfInfo = await page.evaluate(async () => {
    const urls = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      urls.push(blob);
      return orig(blob);
    };
    document.querySelector(".downloads .btn").click(); // first button = PDF
    for (let i = 0; i < 120 && !urls.length; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!urls.length) return null;
    const buf = new Uint8Array(await urls[0].arrayBuffer());
    return { size: buf.length, magic: String.fromCharCode(...buf.slice(0, 5)) };
  });
  console.log("pdf export:", JSON.stringify(pdfInfo));
  if (!pdfInfo || pdfInfo.magic !== "%PDF-" || pdfInfo.size < 5000) {
    failed = true;
    console.error("PDF export failed or produced a trivial file");
  }
} catch (err) {
  failed = true;
  console.error("SMOKE FAIL:", err.message);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
