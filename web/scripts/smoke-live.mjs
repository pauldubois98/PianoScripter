// Live-mode smoke: fake microphone (Chrome tone generator), run a few seconds,
// stop, expect the final pass to reach the done state without page errors.
// Run: node scripts/smoke-live.mjs

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const chrome = ["/usr/bin/google-chrome", "/snap/bin/chromium", "/usr/bin/chromium"].find(existsSync);
const server = spawn("npx", ["vite", "preview", "--port", "4181", "--strictPort"], { stdio: "pipe" });
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => d.toString().includes("4181") && resolve());
  setTimeout(() => reject(new Error("preview server did not start")), 15000);
});

let failed = false;
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => {
    failed = true;
    console.error("[pageerror]", e.message);
  });
  page.on("console", (m) => m.type() === "error" && console.error("[console]", m.text()));

  await page.goto("http://localhost:4181/", { waitUntil: "networkidle2" });
  // second action button = live session
  await page.evaluate(() => document.querySelectorAll(".actions .action")[1].click());
  await page.waitForSelector(".rec-dot", { timeout: 15000 });
  console.log("live session running…");
  await new Promise((r) => setTimeout(r, 9000));

  const liveState = await page.evaluate(() => ({
    timer: document.querySelector(".timer")?.textContent,
    canvas: !!document.querySelector("canvas"),
    hint: document.querySelector(".card.center .hint")?.textContent?.slice(0, 60),
  }));
  console.log("live state:", JSON.stringify(liveState));

  await page.evaluate(() => document.querySelector(".btn.danger").click());
  await page.waitForSelector(".downloads", { timeout: 120000 });
  const chips = await page.evaluate(() =>
    [...document.querySelectorAll(".chip")].map((c) => c.textContent.trim())
  );
  console.log("finalized:", JSON.stringify(chips));
} catch (err) {
  failed = true;
  console.error("LIVE SMOKE FAIL:", err.message);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
