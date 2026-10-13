/**
 * A command's log is bounded on disk while the command runs: the first part and
 * the latest part of the output are kept, the dropped middle is counted in the
 * file, and the readers (notice tail, failure excerpt, "Output too large") say so.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });
const { BoundedLog, LOG_MAX_BYTES } = await jiti.import(`${KIT_ROOT}/lib/tools/bounded-log.ts`);
const { readLogEnds, readLogTail } = await jiti.import(`${KIT_ROOT}/lib/tools/background-task-log.ts`);
const { cutBashOutput } = await jiti.import(`${KIT_ROOT}/lib/tools/bash-result-notices.ts`);

const SINK = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-log-"));
const MIB = 1 << 20;

console.log("bounded log: a small output is the file, byte for byte");
{
	const file = path.join(SINK, "small.log");
	const log = new BoundedLog(file);
	log.write(Buffer.from("hello\n"));
	log.write(Buffer.from("world\n"));
	log.close();
	check("nothing is dropped below the bound", fs.readFileSync(file, "utf8") === "hello\nworld\n");
}

console.log("\nbounded log: 256 MiB of numbered lines");
const file = path.join(SINK, "big.log");
{
	const log = new BoundedLog(file);
	const line = (n) => `line ${String(n).padStart(9, "0")}\n`;
	const perChunk = 4_000;
	let n = 0;
	let largest = 0;
	const total = Math.ceil((256 * MIB) / (perChunk * 15));
	for (let c = 0; c < total; c++) {
		let chunk = "";
		for (let i = 0; i < perChunk; i++) chunk += line(n++);
		log.write(Buffer.from(chunk));
		largest = Math.max(largest, fs.statSync(file).size);
	}
	log.close();
	check(`the file never exceeded ${LOG_MAX_BYTES} bytes while the command ran (largest ${largest})`, largest <= LOG_MAX_BYTES, String(largest));
	check("and the bound is at most 32 MiB", LOG_MAX_BYTES <= 32 * MIB);
	const text = fs.readFileSync(file, "utf8");
	check("it starts with the first line of output", text.startsWith(line(0)));
	check("it ends with the last line of output", text.endsWith(line(n - 1)), text.slice(-40));
	const marker = /\n\[\.\.\. (\d+) bytes omitted[^\n]*\n/.exec(text);
	check("it records how many bytes were dropped in the middle", marker !== null);
	check("the count is exact: bytes kept plus bytes dropped are all the bytes written", marker !== null && Number(marker[1]) + Buffer.byteLength(text) - marker[0].length === n * 15, `${marker?.[1]} of ${n * 15}`);

	const ends = readLogEnds(file, 100, 100);
	check("readLogEnds reports the dropped bytes", ends.droppedBytes === Number(marker?.[1]), String(ends.droppedBytes));
	check("readLogTail still returns the latest lines", readLogTail(file).includes(line(n - 1).trim()));
	const cut = cutBashOutput(ends, false, file);
	check("'Output too large' says the middle was dropped", cut !== undefined && cut.includes("bytes in the middle were dropped") && cut.includes(file), cut);
	check("'Output too large' states the whole output size, not the file's", cut !== undefined && cut.includes(`Output too large (${(n * 15 / 1048576).toFixed(1)}MB)`), cut?.slice(0, 80));
	const failedCut = cutBashOutput(ends, true, file);
	check("a failed run's excerpt says so too", failedCut !== undefined && failedCut.includes("bytes in the middle were dropped"), failedCut);
}

console.log("\nbounded log: a log that was never cut reports nothing dropped");
{
	const small = path.join(SINK, "uncut.log");
	fs.writeFileSync(small, "x".repeat(10_000));
	check("droppedBytes is 0", readLogEnds(small, 10, 10).droppedBytes === 0);
}

fs.rmSync(SINK, { recursive: true, force: true });
await finish();
