/**
 * The bash scan guard (extensions/tool-call-guard/bash-scan-guard.ts): which
 * shell commands are refused for walking `/`, `$HOME`, or a tree with `grep -r`.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });
const { scanRefusal } = await jiti.import(`${KIT_ROOT}/extensions/tool-call-guard/bash-scan-guard.ts`);

const HOME = os.homedir();
const REPO = path.join(HOME, "dotfiles");

// ---------------------------------------------------------------------------
console.log("bash-scan-guard: what a scan may be rooted at");
{
	const at = (cwd) => ({ cwd, home: HOME });
	const blocked = (name, input, cwd = REPO) => scanRefusal(name, input, at(cwd)) !== undefined;

	// grep/find/ls are deleted from every seat (map C6), so the only scan that
	// can still be typed is a bash one. A guard for a tool that cannot be called
	// is the false promise the ruling was written against.
	check("the deleted built-ins have no guard, because they have no seat", !blocked("grep", { pattern: "x", path: "/" }) && !blocked("find", { pattern: "*", path: HOME }) && !blocked("ls", { path: "/" }));

	const bash = (command, cwd = REPO) => scanRefusal("bash", { command }, at(cwd));
	check("bash `find /` is refused", bash("find / -name '*.log'") !== undefined);
	check("bash `find $HOME` is refused in every spelling", ["find $HOME -name x", "find ~ -name x", "find ${HOME} -name x", `find ${HOME} -name x`, "find ~/ -name x"].every((c) => bash(c) !== undefined));
	check("bash `grep -r` at a broad root is refused", bash("grep -r pattern /") !== undefined && bash("grep -rn pattern $HOME") !== undefined);
	check("recursive grep is refused at any root, not just broad ones", bash("grep -rn pattern src") !== undefined && bash("grep -R x .") !== undefined);
	check("a recursive flag hiding in a cluster is still one", bash("grep -inr x lib") !== undefined && bash("grep --recursive x lib") !== undefined);
	check("grep in a pipe is ordinary work", bash("ps aux | grep node") === undefined && bash("history | grep -i ssh") === undefined);
	check("bash `rg` at a broad root is refused", bash("rg --hidden pattern /") !== undefined && bash("rg pattern ~") !== undefined);
	check("a scan hiding behind a pipe or a && is still found", bash("cd /tmp && find / -name x") !== undefined && bash("echo hi; rg pattern $HOME | head") !== undefined);
	check("a full path to the program does not evade it", bash("/usr/bin/find / -name x") !== undefined);

	check("invariant: a quoted empty fd pattern keeps its argv position, so '/' is the root", bash("fd '' /") !== undefined && bash('fd "" /') !== undefined && bash("fd -H '' /") !== undefined && bash("fd '' src") === undefined);
	check("fd's first argument is a pattern, so only a later root is a scan", bash("fd pattern /") !== undefined && bash("fd / src") === undefined);
	check("`find .` is ordinary work", bash("find . -name '*.ts'") === undefined && bash("find . -name '*.ts'", HOME) === undefined);
	check("a named subtree is ordinary work", bash("find pi/kit -name '*.ts'") === undefined && bash(`find ${REPO}/pi -type f`) === undefined && bash("rg pattern src/") === undefined);
	check("a path that merely contains a slash is not a broad root", bash("rg pattern /etc/nginx") === undefined && bash("find /var/log -name '*.log'") === undefined);
	check("a non-recursive grep of one file is not a scan", bash("grep pattern /etc/hosts") === undefined);
	check("a pattern that looks like a root is not one", bash("rg / --files-with-matches") === undefined);
	check("commands that walk nothing are untouched", bash("ls /") === undefined && bash("cat /etc/hosts") === undefined && bash("echo find /") === undefined);

	// The three false blocks of 2026-09-02/03. Each is text that merely mentions
	// a scan; the old regex split them into fake commands and refused a program
	// the user never ran, naming it in the refusal.
	check("a pipe inside quotes is not a pipeline", bash('echo "use rg not grep -r|find / here"') === undefined && bash(`node -e 'const s = "a|find /"'`) === undefined);
	check("a heredoc body is data, not commands", bash("cat <<'EOF'\nfind / -name x\ngrep -rn foo\nEOF") === undefined && bash("cat <<EOF > f\nsome | text\nEOF\nls") === undefined);
	check("a quoted scan in an argument is not a scan", bash("echo 'grep -rn foo'") === undefined && bash("git commit -m 'fix: find / bug'") === undefined);
	check("an alternation regex is a pattern, not a pipe", bash("rg 'a|b' src") === undefined && bash('rg "find /|rm -rf" lib') === undefined);
	check("a comment naming a scan does not run one", bash("# find / -name x\nls") === undefined);

	// The blindness ran the other way too: nothing looked inside a substitution.
	check("a scan inside $() is still a scan", bash("ls $(find / -name x)") !== undefined && bash("echo `grep -rn foo .`") !== undefined);
	check("and inside a nested one", bash("echo $(echo $(find ~ -name x))") !== undefined);
	check("arithmetic is not a command", bash("echo $((1 + 2))") === undefined);

	check("an env-var prefix does not hide the program", bash("FOO=1 BAR=2 find / -name x") !== undefined);
	check("`rg --files` takes no pattern, so its first word is a root", bash("rg --files /") !== undefined && bash("rg --files ~") !== undefined && bash("rg --files src") === undefined);
	check("a wrapper does not hide the program", ["sudo find / -name x", "sudo -u root find / -name x", "time find / -name x", "time -p rg x ~", "env find / -name x", "env -i FOO=1 find ~ -name x", "command find / -name x", "xargs find / -name x", "xargs -I {} rg x /", "sudo env FOO=1 time find /"].every((c) => bash(c) !== undefined), "");
	check("nor a recursive grep", bash("sudo grep -rn x src") !== undefined && bash("xargs -0 grep -r x") !== undefined);
	check("a wrapped command at a named path is ordinary work", bash("sudo find /var/log -name x") === undefined && bash("time rg x src") === undefined && bash("env FOO=1 ls /") === undefined);
	check("a quoted program name is the same program", bash(`"find" / -name x`) !== undefined && bash("find '/' -name x") !== undefined);
	check("a line continuation keeps one command whole", bash("find \\\n / -name x") !== undefined);
	check("a redirection target is not an argument", bash("echo hi > /tmp/out && find / -x") !== undefined && bash("rg pattern src 2>/dev/null") === undefined);
	check("a scan behind a control keyword is found", bash("for d in a b; do find / -name x; done") !== undefined && bash("if true; then rg x ~; fi") !== undefined);
	check("a scan in a subshell or brace group is found", bash("(cd /tmp && find / -name x)") !== undefined && bash("{ find ~ -name x; }") !== undefined);
	check("a run of separators makes no phantom command", bash("a | b; c && d || e") === undefined);

	const reason = scanRefusal("bash", { command: "find / -name x" }, at(REPO));
	check("the reason tells the model what to do instead", reason.includes("Re-run it rooted at a specific path"), reason);
	check("and names the root it refused", reason.includes("`find` at /"), reason);
	check("a $HOME refusal says so in words", bash("rg x $HOME").includes("your home directory"));

	const grepReason = bash("grep -rn pattern src");
	check("the grep refusal names rg and the gitignore gotcha", grepReason.includes("rg") && grepReason.includes("-uu"), grepReason);
}

await finish();
