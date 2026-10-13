/**
 * The bash kill guard (extensions/tool-call-guard/kill-guard.ts): which kills are refused because they may
 * reach a process this session did not start.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti({ moduleCache: false });
const { killRefusal } = await jiti.import(`${KIT_ROOT}/extensions/tool-call-guard/kill-guard.ts`);

const OWN = new Set([4242, 4343]);

const bash = (command, ownTree = () => OWN, stopMine = false) => killRefusal("bash", { command }, { ownTree, stopMine });

console.log("kill-guard: which kills may run");
{
	const blocked = (command) => bash(command) !== undefined;
	const allowed = (command) => bash(command) === undefined;

	check("pkill and killall are refused with any arguments", ["pkill node", "pkill -f 'vite dev'", "pkill -9 -u joel chrome", "killall Chrome", "killall -9 node", "/usr/bin/pkill x"].every(blocked));
	check("a pid outside the session's tree is refused", ["kill 999", "kill -9 999", "kill -s KILL 999", "kill -TERM 4242 999", "sudo kill 999", "/bin/kill 999", "builtin kill 999", "cd /tmp && kill 999"].every(blocked));
	check("kill 0 and a negative pid signal a process group and are refused", ["kill 0", "kill -9 0", "kill -- -4242", "kill -9 -1", "kill -TERM -4242", "kill -s TERM -- -4242"].every((command) => bash(command)?.includes("process group")));
	check("pids the guard cannot read are refused", ["kill $(pgrep node)", "kill -9 `lsof -t -i:3000`", "kill \"$(cat pid)\"", "kill $PID", "for p in $(pgrep x); do kill $p; done", "kill -9 $(ps aux | rg vite | awk '{print $2}')"].every(blocked));
	check("xargs kill is refused", ["pgrep node | xargs kill", "xargs -n1 kill -9 < pids", "lsof -t -i:3000 | xargs kill"].every(blocked));

	check("a pid in the session's own tree runs", ["kill 4242", "kill -9 4242", "kill -s TERM 4242", "kill -KILL -- 4242 4343"].every(allowed));
	check("$! and a variable assigned from it in the same command run", ["sleep 9 & kill $!", "sleep 9 & P=$!; kill $P", 'sleep 9 & P=$!; sleep 1; kill -9 "${P}"'].every(allowed));
	check("a job of this command's own shell runs", ["sleep 9 & kill %1", "kill %%"].every(allowed));
	check("kill -l lists signals and signals nothing", allowed("kill -l"));
	check("text that mentions a kill runs nothing", ["echo pkill node", "git commit -m 'stop: pkill node was the bug'", "rg pkill src", "cat <<'EOF'\nkill 999\nEOF"].every(allowed));
	check("a variable not assigned from $! in this command is still refused", blocked("P=123; kill $P") && blocked("P=$!x; kill $P"));

	check("the process tree is read only when a literal pid needs it", bash("sleep 9 & kill $!", () => { throw new Error("read"); }) === undefined && bash("pkill x", () => { throw new Error("read"); }) !== undefined);
	check("other tools are not judged", killRefusal("Read", { command: "pkill node" }, { ownTree: () => OWN, stopMine: false }) === undefined);

	const reason = bash("kill 999");
	check("the refusal names what it blocked", reason.includes("`kill 999`"), reason);
	check("stop-mine advice appears only where the repo has it", !reason.includes("stop-mine") && bash("kill 999", () => OWN, true).includes("npm run stop-mine"));
	check("and a pkill refusal names pkill", bash("pkill node").includes("`pkill`"));
}

await finish();
