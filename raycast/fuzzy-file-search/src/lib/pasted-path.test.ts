import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { lookupPastedPath, normalizePastedPath } from "./pasted-path.ts";

const home = "/Users/someone";

test("normalizePastedPath keeps a plain absolute path", () => {
  assert.equal(normalizePastedPath("/tmp/dw/motion_both.png", home), "/tmp/dw/motion_both.png");
});

test("normalizePastedPath unescapes shell backslash escapes", () => {
  assert.equal(
    normalizePastedPath("/var/x/Screenshot\\ 2026-09-24\\ at\\ 12.54.32\\ \\(2\\).png", home),
    "/var/x/Screenshot 2026-09-24 at 12.54.32 (2).png",
  );
});

test("normalizePastedPath strips single and double quotes", () => {
  assert.equal(normalizePastedPath("'/tmp/a b\\c.png'", home), "/tmp/a b\\c.png");
  assert.equal(normalizePastedPath('"/tmp/a b \\"c\\".png"', home), '/tmp/a b "c".png');
});

test("normalizePastedPath decodes file:// URLs", () => {
  assert.equal(normalizePastedPath("file:///tmp/a%20b.png", home), "/tmp/a b.png");
  assert.equal(normalizePastedPath("'file:///tmp/a%20b.png'", home), "/tmp/a b.png");
});

test("normalizePastedPath expands a leading ~", () => {
  assert.equal(normalizePastedPath("~/Desktop/a.png", home), "/Users/someone/Desktop/a.png");
  assert.equal(normalizePastedPath("~", home), "/Users/someone");
});

test("normalizePastedPath trims surrounding whitespace and newlines", () => {
  assert.equal(normalizePastedPath("  /tmp/a\\ b.png \n", home), "/tmp/a b.png");
});

test("normalizePastedPath returns null for non-path text", () => {
  assert.equal(normalizePastedPath("motion both", home), null);
  assert.equal(normalizePastedPath("'relative/file.png'", home), null);
  assert.equal(normalizePastedPath("~other/file", home), null);
  assert.equal(normalizePastedPath("", home), null);
});

test("lookupPastedPath resolves escaped, file:// and realpath forms of a file with spaces", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pasted-path-"));
  const file = path.join(dir, "Screenshot 2026-09-24 at 12.54.32.png");
  fs.writeFileSync(file, "");
  const forms = [file.replaceAll(" ", "\\ "), `'${file}'`, pathToFileURL(file).href, fs.realpathSync(file)];
  for (const form of forms) {
    const lookup = await lookupPastedPath(form, home);
    assert.equal(lookup?.exact?.isDirectory, false, form);
  }
  const typedForm = (await lookupPastedPath(file.replaceAll(" ", "\\ "), home))?.exact?.path;
  assert.equal(typedForm, file);
  fs.rmSync(dir, { recursive: true });
});

test("lookupPastedPath completes a partial basename case-insensitively, newest first, and marks directories", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pasted-path-"));
  fs.writeFileSync(path.join(dir, "Motion_both.png"), "");
  fs.mkdirSync(path.join(dir, "motion-frames"));
  fs.writeFileSync(path.join(dir, "other.png"), "");
  const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(dir, "Motion_both.png"), lastWeek, lastWeek);
  const lookup = await lookupPastedPath(`${dir}/moti`, home);
  assert.equal(lookup?.exact, null);
  assert.deepEqual(
    lookup?.completions.map((entry) => ({ path: entry.path, isDirectory: entry.isDirectory })),
    [
      { path: path.join(dir, "motion-frames"), isDirectory: true },
      { path: path.join(dir, "Motion_both.png"), isDirectory: false },
    ],
  );
  const listing = await lookupPastedPath(`${dir}/`, home);
  assert.equal(listing?.exact?.isDirectory, true);
  assert.equal(listing?.completions.length, 3);
  fs.rmSync(dir, { recursive: true });
});
