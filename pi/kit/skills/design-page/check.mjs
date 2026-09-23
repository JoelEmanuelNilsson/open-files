// One call: screenshots the page and prints the mechanical bar.
//   node ~/.agents/skills/design-page/check.mjs <page-dir>
// Run from a repo that has playwright-core in node_modules. Writes
// shot-1920.png and shot-1440.png into <page-dir>, prints one JSON object.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = path.resolve(process.argv[2] ?? ".");
const { chromium } = createRequire(path.join(process.cwd(), "package.json"))("playwright-core");

const WORD_BAR = 1000;

const browser = await chromium.launch();
const report = { dir, shots: [], problems: [] };
for (const [w, h, name] of [[1920, 1080, "shot-1920.png"], [1440, 900, "shot-1440.png"]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(pathToFileURL(path.join(dir, "index.html")).href, { waitUntil: "load" });
  await page.addStyleTag({ content: "*{scroll-behavior:auto !important}" });
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => {
    const words = (el) => el.innerText.split(/\s+/).filter(Boolean).length;
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("details").forEach((d) => [...d.children].forEach((c) => { if (c.tagName !== "SUMMARY") c.remove(); }));
    clone.querySelectorAll("script,style,.pop,#dict").forEach((s) => s.remove());
    const holder = document.createElement("div");
    holder.style.cssText = "position:absolute;left:-99999px";
    holder.appendChild(clone);
    document.body.appendChild(holder);
    const topLayerWords = words(clone);
    holder.remove();

    const EX = JSON.parse(document.getElementById("explain").textContent);
    const marked = [...new Set([...document.querySelectorAll("[data-t]")].map((e) => e.dataset.t))];
    const termsWithoutEntry = marked.filter((t) => !EX[t]);
    const entriesNeverMarked = Object.keys(EX).filter((t) => !marked.includes(t));
    const fills = (document.documentElement.outerHTML.match(/<!--\s*fill:/g) || []).length
      + (document.body.innerText.match(/\[[^\]\n]{6,}\]/g) || []).length;
    const unlabeled = [...document.querySelectorAll("svg, .story, .flow, .options, .answer, [role=group]")]
      .filter((el) => !el.getAttribute("aria-label") && !el.closest("[aria-label]") && !el.closest("[aria-hidden=true]"))
      .map((el) => el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""));
    const kickers = [...document.querySelectorAll("h1,h2,h3")]
      .filter((h) => { const p = h.previousElementSibling; return p && /^(p|span|div)$/i.test(p.tagName) && p.innerText.trim().length < 80 && p.innerText === p.innerText.toUpperCase(); })
      .map((h) => h.innerText.slice(0, 60));
    return {
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      topLayerWords, marked: marked.length, entries: Object.keys(EX).length,
      termsWithoutEntry, entriesNeverMarked, fills, unlabeled, kickers,
    };
  });
  await page.screenshot({ path: path.join(dir, name), fullPage: true });
  report.shots.push({ name, width: w, ...m });
  await page.close();
}
await browser.close();

const m = report.shots[0];
if (m.overflowX) report.problems.push("page scrolls sideways at 1920");
if (m.topLayerWords > WORD_BAR) report.problems.push(`top layer has ${m.topLayerWords} words; bar is ${WORD_BAR}`);
if (m.termsWithoutEntry.length) report.problems.push(`terms with no explain entry: ${m.termsWithoutEntry.join(", ")}`);
if (m.entriesNeverMarked.length) report.problems.push(`explain entries no term points at: ${m.entriesNeverMarked.join(", ")}`);
if (m.fills) report.problems.push(`${m.fills} template placeholders still on the page`);
if (m.unlabeled.length) report.problems.push(`pictures without aria-label: ${m.unlabeled.join(", ")}`);
if (m.kickers.length) report.problems.push(`kicker line above heading: ${m.kickers.join(" | ")}`);
report.verdict = report.problems.length ? "not yet" : "clear";
console.log(JSON.stringify(report, null, 1));
process.exit(report.problems.length ? 1 : 0);
