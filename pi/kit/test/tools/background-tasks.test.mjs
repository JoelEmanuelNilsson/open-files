import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti({ moduleCache: false });
const { adoptBackgroundTask, backgroundTasksOf, deliveredBackgroundTask, endBackgroundTasksOf, heldLogPaths, nextBackgroundTaskId, readBackgroundTask, reofferHeldBackgroundTasks, stashTasksEndedWithSession, stopBackgroundTask, takeTasksEndedWithSession, watchBackgroundTasksOf } = await jiti.import(`${KIT_ROOT}/lib/tools/background-tasks.ts`);
const { claimScreen } = await jiti.import(`${KIT_ROOT}/lib/process/human-notice.ts`);

const EVENTS = ["exit", "finished", "stop", "read", "endOwner", "messageEnd", "leave", "reoffer"];
const VERDICTS_AFTER_REOFFER = ["turned", "appended", "not-now"];
const MUTES = ["finished", "kill", "stop", "read-wait", "endOwner", "messageEnd", "reoffer"];

function* orders(items) {
	if (items.length <= 1) {
		yield items;
		return;
	}
	for (let i = 0; i < items.length; i++) for (const rest of orders([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i], ...rest];
}

const flush = async () => {
	for (let i = 0; i < 4; i++) await Promise.resolve();
};

const UNKNOWN = { exitCode: null, signal: null };

/** The spec's state table, written out: what one order of events must deliver, read and reply. */
function expected(order, verdictAfterReoffer) {
	const m = { at: "running", alive: true, exitedWith: undefined, verdict: "turned", waiting: false, held: undefined };
	const deliveries = [];
	const readings = [];
	const stops = [];
	const deliver = (kind, result) => deliveries.push({ kind, ...result });
	const resolveWaiter = (state) => {
		if (!m.waiting) return;
		m.waiting = false;
		readings[readings.length - 1] = state;
	};
	const sink = (result) => {
		if (m.waiting) {
			deliver("waiter", result);
			resolveWaiter("finished");
			m.at = "gone";
		} else if (m.verdict === "turned") {
			deliver("notice", result);
			m.at = "noticed";
		} else if (m.verdict === "appended") {
			deliver("notice", result);
			m.at = "gone";
		} else {
			m.held = result;
			m.at = "held";
		}
	};
	const exit = () => {
		m.exitedWith ??= m.alive ? { exitCode: 0, signal: null } : { exitCode: null, signal: "SIGKILL" };
		m.alive = false;
	};
	for (const event of order) {
		if (event === "exit") exit();
		if (event === "finished") {
			exit();
			if (m.at === "running" || m.at === "killing") sink({ ...m.exitedWith, how: m.at === "killing" ? "stopped" : "exited" });
		}
		if (event === "stop") {
			if (m.at === "running" && m.alive) {
				m.alive = false;
				m.at = "killing";
				stops.push("stopping");
			} else if (m.at === "running") {
				const result = { ...(m.exitedWith ?? UNKNOWN), how: "exited" };
				if (m.waiting) {
					deliver("waiter", result);
					resolveWaiter("finished");
					stops.push("in-conversation");
				} else {
					deliver("stop", result);
					stops.push("ended");
				}
				m.at = "gone";
			} else if (m.at === "killing") stops.push("stopping");
			else if (m.at === "noticed") stops.push("in-conversation");
			else if (m.at === "held") {
				deliver("stop", m.held);
				stops.push("ended");
				m.at = "gone";
			} else stops.push("none");
		}
		if (event === "read") {
			if (m.at === "running" || m.at === "killing") {
				m.waiting = true;
				readings.push("pending");
			} else if (m.at === "noticed") readings.push("noticed");
			else if (m.at === "held") {
				deliver("read", m.held);
				readings.push("finished");
				m.at = "gone";
			}
		}
		if (event === "endOwner") {
			if (m.at === "running") {
				if (m.alive) {
					m.alive = false;
					deliver("owner", { ...UNKNOWN, how: "killed-with-owner" });
				} else deliver("owner", { ...(m.exitedWith ?? UNKNOWN), how: "exited" });
			} else if (m.at === "killing") deliver("owner", { ...(m.exitedWith ?? UNKNOWN), how: "stopped" });
			else if (m.at === "held") deliver("owner", m.held);
			resolveWaiter("owner-ended");
			m.at = "gone";
		}
		if (event === "messageEnd" && m.at === "noticed") m.at = "gone";
		if (event === "leave") m.verdict = "not-now";
		if (event === "reoffer") {
			m.verdict = verdictAfterReoffer;
			if (m.at === "held") sink(m.held);
		}
	}
	return { deliveries, readings, stops };
}

let runs = 0;
/** Drives the registry through one order over a fake process; returns what reached each destination, as a ledger. */
async function play(order, verdictAfterReoffer, mute) {
	const owner = `owner-${++runs}`;
	const logPath = `/nonexistent/${owner}.log`;
	const proc = {
		alive: true,
		exitedWith: undefined,
		kill() {
			if (mute === "kill" || !this.alive) return false;
			this.alive = false;
			return true;
		},
	};
	let verdict = "turned";
	const deliveries = [];
	const deliver = (kind, result) => deliveries.push({ kind, exitCode: result.exitCode, signal: result.signal, how: result.how });
	const handle = adoptBackgroundTask(owner, { id: 1, command: "make", logPath }, proc, (task) => {
		if (verdict !== "not-now") deliver("notice", task);
		return verdict;
	}, Date.now());
	const readings = [];
	const stops = [];
	for (const event of order) {
		const exit = () => {
			proc.exitedWith ??= proc.alive ? { exitCode: 0, signal: null } : { exitCode: null, signal: "SIGKILL" };
			proc.alive = false;
		};
		if (event === "exit") exit();
		if (event === "finished") {
			exit();
			if (mute !== "finished") handle.finished(proc.exitedWith);
		}
		if (event === "stop" && mute !== "stop") {
			const reply = stopBackgroundTask(owner, 1);
			stops.push(reply === undefined ? "none" : (reply.at ?? "stopping"));
			if (reply?.at === "ended") deliver("stop", reply.result);
		}
		if (event === "read") {
			const pending = readBackgroundTask(owner, 1, mute === "read-wait" ? 0 : 60_000);
			if (pending !== undefined) {
				const reading = { state: "pending" };
				readings.push(reading);
				let sameEvent = true;
				void pending.then((value) => {
					reading.state = value.state;
					if (value.state === "finished") deliver(sameEvent ? "read" : "waiter", value.task);
				});
				await flush();
				sameEvent = false;
			}
		}
		if (event === "endOwner" && mute !== "endOwner") for (const task of endBackgroundTasksOf(owner)) deliver("owner", task);
		if (event === "messageEnd" && mute !== "messageEnd") deliveredBackgroundTask(owner, 1);
		if (event === "leave") verdict = "not-now";
		if (event === "reoffer") {
			verdict = verdictAfterReoffer;
			if (mute !== "reoffer") reofferHeldBackgroundTasks(owner);
		}
		await flush();
	}
	const want = expected(order, verdictAfterReoffer);
	const problems = [];
	if (deliveries.length !== 1) problems.push(`${deliveries.length} deliveries (${deliveries.map((d) => d.kind).join(",")})`);
	if (JSON.stringify(deliveries) !== JSON.stringify(want.deliveries)) problems.push(`delivered ${JSON.stringify(deliveries)}, spec ${JSON.stringify(want.deliveries)}`);
	const states = readings.map((r) => r.state);
	if (states.includes("pending")) problems.push("a waiter never resolved");
	if (JSON.stringify(states) !== JSON.stringify(want.readings)) problems.push(`read ${states.join(",")}, spec ${want.readings.join(",")}`);
	if (JSON.stringify(stops) !== JSON.stringify(want.stops)) problems.push(`stop replied ${stops.join(",")}, spec ${want.stops.join(",")}`);
	if (backgroundTasksOf(owner).length !== 0 || heldLogPaths().has(logPath)) problems.push("left in the registry");
	endBackgroundTasksOf(owner);
	return problems;
}

async function playAll(mute) {
	let played = 0;
	let failed = 0;
	const examples = [];
	for (const order of orders(EVENTS)) {
		for (const after of VERDICTS_AFTER_REOFFER) {
			played++;
			const problems = await play(order, after, mute);
			if (problems.length === 0) continue;
			failed++;
			if (examples.length < 5) examples.push(`${order.join(" ")} (${after}): ${problems.join("; ")}`);
		}
	}
	return { played, failed, examples };
}

const all = await playAll(undefined);
check(`every order of ${EVENTS.join(", ")} (${all.played} runs): each result delivered exactly once, where the spec sends it; every waiter resolved; the registry empty`, all.failed === 0, `${all.failed} failed\n${all.examples.join("\n")}`);

const caught = [];
for (const mute of MUTES) caught.push({ mute, failed: (await playAll(mute)).failed });
check(`the order test sees every transition: muting any one fails some order (${caught.map((c) => `${c.mute} ${c.failed}`).join(", ")})`, caught.every((c) => c.failed > 0), JSON.stringify(caught));

/** A process whose shell is still running, and the task id its owner allocated for it. */
function runningTask(owner, notice = () => "turned") {
	const id = nextBackgroundTaskId(owner);
	const proc = { alive: true, exitedWith: undefined, kill() { const was = this.alive; this.alive = false; return was; } };
	const handle = adoptBackgroundTask(owner, { id, command: `job ${id}`, logPath: `/nonexistent/${owner}-${id}.log` }, proc, notice, Date.now());
	return { id, proc, handle };
}

{
	const first = runningTask("ids");
	const second = runningTask("ids");
	endBackgroundTasksOf("ids");
	const afterEnd = runningTask("ids");
	const other = runningTask("ids-other");
	check("task ids are per owner and never reused in the process, even after its tasks ended", `${first.id},${second.id},${afterEnd.id},${other.id}` === "1,2,3,1");
	let refused = "";
	try {
		adoptBackgroundTask("ids", { id: afterEnd.id, command: "again", logPath: "/nonexistent/again.log" }, afterEnd.proc, () => "turned", Date.now());
	} catch (error) {
		refused = error.message;
	}
	check("adopting an id the owner already holds throws and leaves the held task", refused === "background task 3 of ids is already registered" && backgroundTasksOf("ids").map((t) => t.command).join() === "job 3", refused);
	endBackgroundTasksOf("ids");
	endBackgroundTasksOf("ids-other");
}

{
	const logged = [];
	const release = claimScreen((message, level) => logged.push(`${level}: ${message}`));
	runningTask("watched");
	runningTask("watched");
	let woken = 0;
	const unwatchThrowing = watchBackgroundTasksOf("watched", () => {
		throw new Error("watcher boom");
	});
	const unwatchCounting = watchBackgroundTasksOf("watched", () => woken++);
	const ended = endBackgroundTasksOf("watched");
	check("a throwing watcher is logged and the owner's end still ends every task and wakes every other watcher", ended.length === 2 && backgroundTasksOf("watched").length === 0 && woken === 2 && logged.filter((line) => line === "error: background tasks: a watcher of watched threw: watcher boom").length === 2, JSON.stringify({ ended: ended.length, woken, logged }));
	release();
	unwatchThrowing();
	unwatchCounting();

	const unwatchStale = watchBackgroundTasksOf("rewatched", () => {});
	unwatchStale();
	let fresh = 0;
	watchBackgroundTasksOf("rewatched", () => fresh++);
	unwatchStale();
	runningTask("rewatched");
	endBackgroundTasksOf("rewatched");
	check("a stale unsubscribe called again leaves a newer watcher of the owner", fresh === 1, String(fresh));
}

{
	const inside = [];
	const task = runningTask("reentrant", (result) => {
		void readBackgroundTask("reentrant", result.id, 0).then((reading) => inside.push(`read ${reading.state}`));
		inside.push(`stop ${stopBackgroundTask("reentrant", result.id).at}`);
		deliveredBackgroundTask("reentrant", result.id);
		return "turned";
	});
	task.proc.alive = false;
	task.handle.finished({ exitCode: 0, signal: null });
	await flush();
	check("a notice sink that calls back into the registry sees its task noticed, and delivering it there leaves nothing", inside.join() === "stop in-conversation,read noticed" && backgroundTasksOf("reentrant").length === 0, inside.join());

	const listed = [];
	runningTask("reentrant-end");
	runningTask("reentrant-end");
	const unwatch = watchBackgroundTasksOf("reentrant-end", () => listed.push(...endBackgroundTasksOf("reentrant-end")));
	listed.push(...endBackgroundTasksOf("reentrant-end"));
	unwatch();
	check("a watcher that ends the owner's tasks again inside the owner's end lists each task once", listed.map((t) => t.id).sort().join() === "1,2", listed.map((t) => t.id).join());
}

{
	stashTasksEndedWithSession("stashed", [{ id: 1, how: "killed-with-owner" }]);
	stashTasksEndedWithSession("stashed", [{ id: 2, how: "killed-with-owner" }]);
	check("two shutdowns before the next start keep both sets of ended tasks", takeTasksEndedWithSession("stashed").map((task) => task.id).join() === "1,2");
	check("and taking them leaves none", takeTasksEndedWithSession("stashed").length === 0);
}

await finish();