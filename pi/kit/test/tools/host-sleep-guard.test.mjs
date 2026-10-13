/**
 * The agent host and sleep guard (extensions/tool-call-guard/host-sleep-guard.ts): which commands an agent seat may
 * not run because they open a host shell or poll, and the repo opt-in that scopes it.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });
const { hostSleepRefusal } = await jiti.import(`${KIT_ROOT}/extensions/tool-call-guard/host-sleep-guard.ts`);

const refused = (command) => hostSleepRefusal("bash", { command }) !== undefined;

console.log("host-sleep-guard: what an agent seat may not run");
{
	check("a sleep-poll over ssh is refused", refused("sleep 119; ssh devbox 'wc -l /srv/run.log'"));
	check("raw root ssh, scp, rsync and mosh are refused", ["ssh root@1.2.3.4 uptime", "scp a root@1.2.3.4:/x", "rsync -a a host:b", "mosh host", "sudo ssh h ls", "cd /tmp && /usr/bin/ssh h", "timeout 60 ssh -o ConnectTimeout=20 h uptime", "timeout -k 5 60 nohup rsync -a a h:b"].every(refused));
	const devbox = { hostWrappers: ["devbox"], waitWith: "Use `npm run wait`." };
	check("a wrapper the repo lists is a host shell; an unlisted one is not", hostSleepRefusal("bash", { command: "devbox ssh 'ls'" }, devbox) !== undefined && !refused("devbox ssh 'ls'") && hostSleepRefusal("bash", { command: "echo ssh" }, devbox) === undefined);
	check("the refusal adds the repo's own way to wait", hostSleepRefusal("bash", { command: "sleep 60" }, devbox)?.includes("Use `npm run wait`.") === true);
	check("aws shell access is refused, other aws is not", refused("aws ssm start-session --target i-1") && refused("aws ec2-instance-connect send-ssh-public-key --instance-id i-1") && !refused("aws ec2 wait instance-running --instance-ids i-1") && !refused("aws ec2 describe-instances"));
	check("a while or until loop with a sleep is refused", ["while true; do date; sleep 30; done", "until test -f x; do sleep 1; done", "while ! test -f x\ndo sleep 1\ndone"].every(refused));
	check("a sleep over five seconds, or of unreadable length, is refused", ["sleep 6", "sleep 119", "sleep 1m", "sleep 2 3 1", "sleep $N", "sleep 5.5", "sleep 600 && echo hi"].every(refused));
	check("the blocking verbs and a short sleep run", ["npm run wait -- --deadline 600 -- ./experiment.sh", "aws ec2 wait instance-running --instance-ids i-1", "sleep 2", "sleep 5", "sleep 0.5; echo ok", "npm run wait -- sh -c 'sleep 30'"].every((command) => !refused(command)));
	check("the string of bash -c, sh -c and zsh -c is judged, nested too", ["bash -c 'ssh h'", "sh -c 'sleep 100'", "zsh -lc 'ssh h ls'", "bash -c \"sh -c 'ssh h'\"", "bash -c 'while true; do sleep 1; done'"].every(refused) && ["bash -c 'echo ok'", "sh -c 'sleep 2'", "bash script.sh", "bash -n x.sh"].every((command) => !refused(command)));
	check("exec runs its command", refused("exec ssh h") && refused("exec -a name sleep 100") && !refused("exec npm test"));
	check("timeout N cuts a sleep off at N: allowed when N is at most five, refused above", ["timeout 5 sleep 100", "timeout 2s sleep 100", "timeout -k 1 3 sleep 60"].every((c) => !refused(c)) && ["timeout 60 sleep 100", "timeout 6 sleep 100"].every(refused));
	check("a timeout does not excuse a host shell or a polling loop", refused("timeout 3 ssh h") && refused("while true; do timeout 3 sleep 100; done"));
	check("text that mentions ssh or a sleep runs nothing", ["echo ssh root@host", "rg 'ssh ' scripts", "git commit -m 'no sleep 60 polling'", "cat <<'EOF'\nssh h\nEOF"].every((command) => !refused(command)));
	check("other tools are not judged", hostSleepRefusal("Read", { command: "ssh h" }) === undefined);
	const reason = hostSleepRefusal("bash", { command: "ssh h ls" });
	check("the refusal names the blocking alternatives", ["blocking command", "aws ec2 wait", "run_in_background"].every((text) => reason.includes(text)), reason);
}

console.log("host-sleep-guard: only agent seats in an opted-in repo");
{
	const mod = await jiti.import(`${KIT_ROOT}/extensions/tool-call-guard/index.ts`);
	const { declareChildSeat, forgetChildSeat } = await jiti.import(`${KIT_ROOT}/lib/session/seat-identity.ts`);
	const handlers = new Map();
	mod.default({ on: (event, handler) => handlers.set(event, handler) });
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kit-guards-"));
	const optedIn = path.join(root, "in");
	const optedOut = path.join(root, "out");
	fs.mkdirSync(path.join(optedIn, ".pi", "x"), { recursive: true });
	fs.mkdirSync(optedOut, { recursive: true });
	fs.writeFileSync(path.join(optedIn, ".pi", "kit-guards.json"), JSON.stringify({ agentGuards: true }));
	declareChildSeat("agent-seat", { name: "a", role: "worker", depth: 1, parentSessionId: "main-session", workflowChild: false, workflows: false, prompt: { kind: "inherit" } });
	const run = (cwd, sessionId, command) => handlers.get("tool_call")({ toolName: "bash", input: { command }, toolCallId: "t" }, { cwd, sessionManager: { getSessionId: () => sessionId } });
	const ssh = "sleep 119; ssh devbox 'wc -l x'";

	check("a worker in an opted-in repo is blocked, from a subdirectory too", run(optedIn, "agent-seat", ssh)?.block === true && run(path.join(optedIn, ".pi", "x"), "agent-seat", "ssh root@1.2.3.4 ls")?.block === true);
	check("the main seat is not", run(optedIn, "main-session", ssh) === undefined);
	check("a repo without the opt-in is not", run(optedOut, "agent-seat", ssh) === undefined);
	fs.writeFileSync(path.join(optedIn, ".pi", "kit-guards.json"), "{ not json");
	check("an unreadable opt-in file does not opt in", run(optedIn, "agent-seat", ssh) === undefined);
	forgetChildSeat("agent-seat");
	fs.rmSync(root, { recursive: true, force: true });
}

await finish();
