/**
 * Which files under test/ are suite files: the one definition the suite runner
 * runs and the roster guard checks, so a file that exists is a file that runs.
 * `discoverSuiteFiles(testDir)` lists them; `isLiveSuiteFile(file)` marks the
 * ones that hit the real Anthropic API.
 */

import fs from "node:fs";
import path from "node:path";

/** Every *.mjs under testDir, skipping node_modules and dotfiles, as sorted posix paths relative to testDir. */
export function listTestModules(testDir) {
	const found = [];
	const walk = (relativeDir) => {
		for (const entry of fs.readdirSync(path.join(testDir, relativeDir), { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(relative);
			else if (entry.name.endsWith(".mjs")) found.push(relative);
		}
	};
	walk("");
	return found.sort();
}

/** Whether a test/-relative path is a preview script: run by hand to look at a frame, never by the suite runner. */
export function isPreviewScript(file) {
	return file.startsWith("preview/");
}

/** The suite runner itself, relative to test/. */
export const SUITE_RUNNER_FILE = "suite-runner.mjs";

/** Every suite file under testDir (*.test.mjs outside support/ and preview/), sorted, relative to testDir. */
export function discoverSuiteFiles(testDir) {
	return listTestModules(testDir).filter(
		(file) => !file.startsWith("support/") && !isPreviewScript(file) && file.endsWith(".test.mjs"),
	);
}

/** Whether a suite file hits the real Anthropic API, so the runner keeps it in the one serial live lane. */
export function isLiveSuiteFile(file) {
	return /-live(\.test)?\.mjs$/.test(file);
}
