/**
 * The request image budget (`extensions/wire/request-image-budget.ts`) through a
 * real pi seat: a transcript of 30 screenshots of 1.2 MB each — the shape that
 * killed a worker with `413 request_too_large` on 2026-09-25 and failed every
 * resume after — is reopened from disk and resumed. The request that goes out
 * must fit, the cut must be recorded in the session as `context_edit` entries,
 * and the next request and the next resume must send the same bytes for the
 * conversation they share, so the cached prefix moves once.
 *
 *   node test/wire/request-image-budget.test.mjs
 */

import { check, finish } from "../support/check-harness.mjs";
import { importPi, KIT_ROOT } from "../support/pi-package.mjs";
import { createScriptedAgentDir, createScriptedModel, SCRIPTED_MODEL, scriptedMainSeat, scriptedText as text } from "../support/scripted-seat.mjs";
import fs from "node:fs";

createScriptedAgentDir("request-image-budget");
const { SessionManager } = await importPi("dist/index.js");

const LIMIT = 33554432;
const VISION = { ...SCRIPTED_MODEL, id: "scripted-vision-1", input: ["text", "image"], inputLimits: { maxRequestBytes: LIMIT, images: { maxPerRequest: 600 } } };
const FEW = { ...VISION, id: "scripted-few-1", inputLimits: { maxRequestBytes: LIMIT, images: { maxPerRequest: 10 } } };
const scripted = createScriptedModel();
const provider = scripted.providerExtension({ models: [VISION, FEW] });
const seatOn = (id, sessionManager) => scriptedMainSeat(scripted, { extensions: ["extensions/wire/index.ts"], factories: [provider], model: ["scripted", id], sessionManager });

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content, model) => ({ role: "assistant", content, api: "scripted-api", provider: "scripted", model, usage: ZERO, stopReason: content.some((b) => b.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now() });

/** A session file on disk of `count` `read`s of `/shots/ship-<i>.png`, each image `bytes` of distinct base64. */
function transcriptOfShots(model, count, bytes) {
	const manager = SessionManager.create(KIT_ROOT);
	manager.appendModelChange("scripted", model);
	manager.appendMessage({ role: "user", content: "photograph every ship", timestamp: Date.now() });
	for (let i = 0; i < count; i++) {
		const id = `call_${i}`;
		manager.appendMessage(assistant([{ type: "toolCall", id, name: "read", arguments: { path: `/shots/ship-${i}.png` } }], model));
		const data = Buffer.alloc((bytes / 4) * 3, i + 1).toString("base64");
		manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data, mimeType: "image/png" }], isError: false, timestamp: Date.now() });
	}
	manager.appendMessage(assistant([{ type: "text", text: "All ships photographed." }], model));
	return manager.getSessionFile();
}

// System messages are pi's prompt deltas, which wire replaces with its own system array; the conversation is the rest.
const conversationOf = (request) => request.messages.filter((m) => m.role !== "system");
const bytesOf = (messages) => Buffer.byteLength(JSON.stringify(messages));
const imagesIn = (messages) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "image");
const stubsIn = (messages) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "text" && b.text.startsWith("[Image removed from context"));
const entriesOf = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const imagesOnDisk = (file) => entriesOf(file).flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : [])).filter((b) => b.type === "image").length;

// ---------------------------------------------------------------------------
console.log("request-image-budget: a dead transcript of 30 screenshots resumes under the limit");
{
	const file = transcriptOfShots(VISION.id, 30, 1_200_000);
	const onDisk = entriesOf(file).reduce((sum, e) => sum + (Array.isArray(e.message?.content) ? imagesIn([e.message]).reduce((s, b) => s + b.data.length, 0) : 0), 0);
	check("the transcript alone is over the provider's limit", onDisk > LIMIT, String(onDisk));

	const seat = await seatOn(VISION.id, SessionManager.open(file));
	scripted.scriptFor("look at the newest ship again", [[text("Looking.")]]);
	const before = scripted.requests.length;
	await seat.session.prompt("look at the newest ship again");
	await seat.session.waitForIdle();
	const first = scripted.requests[before];
	const sent = first === undefined ? [] : conversationOf(first);
	check("the resumed request goes out", first !== undefined);
	check("and its conversation is under half the limit", bytesOf(sent) <= LIMIT * 0.5, String(bytesOf(sent)));
	const kept = imagesIn(sent);
	const stubs = stubsIn(sent);
	check("the newest images are kept", kept.length > 0 && kept.at(-1).data.startsWith(Buffer.alloc(3, 30).toString("base64")), String(kept.length));
	check("the oldest are stubbed, oldest first", stubs.length + kept.length === 30 && stubs[0]?.text.includes("read of /shots/ship-0.png") && !stubs.some((b) => b.text.includes("/shots/ship-29.png")), stubs[0]?.text);
	check("each stub names the file it replaced", stubs.every((b, i) => b.text.includes(`/shots/ship-${i}.png`)));

	const edits = entriesOf(file).filter((e) => e.type === "context_edit");
	check("the cut is recorded in the session, one context_edit per stubbed read", edits.length === stubs.length, `${edits.length} edits, ${stubs.length} stubs`);
	check("and the session file still holds every original image", imagesOnDisk(file) === 30, String(imagesOnDisk(file)));

	scripted.scriptFor("and the one before it", [[text("Looking again.")]]);
	await seat.session.prompt("and the one before it");
	await seat.session.waitForIdle();
	const second = conversationOf(scripted.requests.at(-1));
	check("the next request sends the same bytes for the conversation it shares", JSON.stringify(second.slice(0, sent.length)) === JSON.stringify(sent));
	check("and cuts nothing more", entriesOf(file).filter((e) => e.type === "context_edit").length === edits.length);
	await seat.runtime.dispose();

	const again = await seatOn(VISION.id, SessionManager.open(file));
	scripted.scriptFor("one more look", [[text("Still here.")]]);
	await again.session.prompt("one more look");
	await again.session.waitForIdle();
	const resumed = conversationOf(scripted.requests.at(-1));
	check("a second resume sends that same conversation, from the session alone", JSON.stringify(resumed.slice(0, second.length)) === JSON.stringify(second));
	await again.runtime.dispose();
}

// ---------------------------------------------------------------------------
console.log("\nrequest-image-budget: the image count a model declares is a limit too");
{
	const file = transcriptOfShots(FEW.id, 12, 4000);
	const seat = await seatOn(FEW.id, SessionManager.open(file));
	scripted.scriptFor("count them", [[text("Counted.")]]);
	await seat.session.prompt("count them");
	await seat.session.waitForIdle();
	const sent = conversationOf(scripted.requests.at(-1));
	check("12 images on a model that takes 10 go out as the newest 5", imagesIn(sent).length === 5 && stubsIn(sent).length === 7, `${imagesIn(sent).length} kept`);
	await seat.runtime.dispose();
}

// ---------------------------------------------------------------------------
console.log("\nrequest-image-budget: a conversation under budget is not touched");
{
	const file = transcriptOfShots(VISION.id, 3, 1_200_000);
	const seat = await seatOn(VISION.id, SessionManager.open(file));
	scripted.scriptFor("small one", [[text("Fine.")]]);
	await seat.session.prompt("small one");
	await seat.session.waitForIdle();
	const sent = conversationOf(scripted.requests.at(-1));
	check("every image goes out and nothing is recorded", imagesIn(sent).length === 3 && !entriesOf(file).some((e) => e.type === "context_edit"));
	await seat.runtime.dispose();
}

await finish();
