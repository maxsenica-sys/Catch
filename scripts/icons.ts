/**
 * Renders web/public/icon.svg to the PNG sizes iOS and Android want.
 * Run after changing the SVG: node scripts/icons.ts  (uses the Playwright Chromium)
 */
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const svg = fs.readFileSync("web/public/icon.svg", "utf8");
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [180, 192, 512]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:#0b1220">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  // iOS rounds the corners itself and shows transparency as black, so render full-bleed.
  await page.screenshot({ path: `web/public/icon-${size}.png`, omitBackground: false });
}
await browser.close();
console.log("icons written");
