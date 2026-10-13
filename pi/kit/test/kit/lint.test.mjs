/**
 * Does `npm run lint` pass? One check per run, so a new unsafe cast fails the suite.
 *
 *   node test/kit/lint.test.mjs
 */

import "../support/suite-env.mjs";
import { spawnSync } from "node:child_process";
import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";

const run = spawnSync("npm", ["run", "lint", "--silent"], { cwd: KIT_ROOT, encoding: "utf8" });
const diagnostics = (run.stdout + run.stderr).split("\n").filter((line) => line.includes("anti-slop("));
check("oxlint finds no anti-slop violations", run.status === 0, diagnostics.slice(0, 20).join("\n"));

await finish();
