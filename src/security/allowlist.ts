// Which shell commands the agent may run. A pure tokenizer for a safe subset of bash (words, quotes and
// pipes only) and a per-command policy. Everything else is refused before the sandbox is even started;
// the sandbox (sandbox.ts) is the second line: whatever passes here still runs in a throwaway overlay.

export type Argv = string[];

export type TokenizeResult = { ok: true; pipeline: Argv[] } | { ok: false; reason: string };
export type PolicyResult = { ok: true; pipeline: Argv[] } | { ok: false; reason: string };

export interface AllowlistOptions {
	/** `make` targets the agent may run (e.g. check-docs, check-todos). */
	makeTargets: string[];
	/** Extra command names allowed with any arguments (still sandboxed). */
	extraCommands: string[];
}

export const DEFAULT_ALLOWLIST: AllowlistOptions = {
	makeTargets: ["check-docs", "check-todos"],
	extraCommands: [],
};

const OPERATOR_CHARS = new Set([";", "&", "<", ">", "(", ")", "`", "\n", "\r"]);
// After `$`, these start an expansion ($VAR, ${...}, $(...), $1, $@, ...). Anything else is a literal `$`.
const EXPANSION_START = /[A-Za-z0-9_{(@*#?$!-]/;

/**
 * Split a command into pipeline stages of argv words. Supported: unquoted words with backslash escapes,
 * 'single quotes', "double quotes" (no expansions inside), and `|` between stages. Refused: `;`, `&`,
 * `&&`, `||`, redirections, subshells, command and process substitution, variable expansion, newlines,
 * comments, brace groups, leading assignments (VAR=x cmd), and here-docs.
 */
export function tokenize(command: string): TokenizeResult {
	const pipeline: Argv[] = [];
	let stage: Argv = [];
	let word = "";
	let inWord = false;
	let i = 0;
	const n = command.length;

	const endWord = () => {
		if (inWord) {
			stage.push(word);
			word = "";
			inWord = false;
		}
	};

	while (i < n) {
		const c = command[i];
		if (c === " " || c === "\t") {
			endWord();
			i++;
			continue;
		}
		if (c === "|") {
			if (command[i + 1] === "|") return { ok: false, reason: "`||` is not allowed: run one command (a pipeline with `|` is fine)" };
			if (command[i + 1] === "&") return { ok: false, reason: "`|&` is not allowed" };
			endWord();
			if (stage.length === 0) return { ok: false, reason: "empty pipeline stage" };
			pipeline.push(stage);
			stage = [];
			i++;
			continue;
		}
		if (OPERATOR_CHARS.has(c)) {
			const what = c === "\n" || c === "\r" ? "a newline" : `\`${c}\``;
			return {
				ok: false,
				reason: `${what} is not allowed: no command lists, redirections, subshells or substitutions; run one command at a time`,
			};
		}
		if (c === "#" && !inWord) return { ok: false, reason: "comments are not allowed" };
		if ((c === "{" || c === "}") && !inWord && (i + 1 >= n || command[i + 1] === " " || command[i + 1] === "\t")) {
			return { ok: false, reason: "brace groups are not allowed" };
		}
		if (c === "$") {
			const next = command[i + 1];
			if (next !== undefined && EXPANSION_START.test(next)) {
				return { ok: false, reason: "shell expansions (`$VAR`, `$(...)`, `${...}`) are not allowed; quote a literal `$` with single quotes" };
			}
			if (next === "'" || next === '"') return { ok: false, reason: "ANSI-C / locale quoting (`$'...'`, `$\"...\"`) is not allowed" };
			word += c;
			inWord = true;
			i++;
			continue;
		}
		if (c === "\\") {
			const next = command[i + 1];
			if (next === undefined) return { ok: false, reason: "a trailing backslash is not allowed" };
			if (next === "\n" || next === "\r") return { ok: false, reason: "line continuations are not allowed" };
			word += next;
			inWord = true;
			i += 2;
			continue;
		}
		if (c === "'") {
			const end = command.indexOf("'", i + 1);
			if (end === -1) return { ok: false, reason: "unterminated single quote" };
			const body = command.slice(i + 1, end);
			if (body.includes("\n") || body.includes("\r")) return { ok: false, reason: "newlines inside quotes are not allowed" };
			word += body;
			inWord = true;
			i = end + 1;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			let body = "";
			let closed = false;
			while (j < n) {
				const d = command[j];
				if (d === '"') {
					closed = true;
					break;
				}
				if (d === "`") return { ok: false, reason: "backticks are not allowed" };
				if (d === "\n" || d === "\r") return { ok: false, reason: "newlines inside quotes are not allowed" };
				if (d === "$") {
					const next = command[j + 1];
					if (next !== undefined && next !== '"' && EXPANSION_START.test(next)) {
						return { ok: false, reason: "shell expansions inside double quotes are not allowed; use single quotes" };
					}
					body += d;
					j++;
					continue;
				}
				if (d === "\\") {
					const next = command[j + 1];
					if (next === undefined) break;
					// inside double quotes only these are escapes; otherwise the backslash stays
					if (next === '"' || next === "\\" || next === "$" || next === "`") {
						body += next;
					} else if (next === "\n") {
						return { ok: false, reason: "line continuations are not allowed" };
					} else {
						body += d + next;
					}
					j += 2;
					continue;
				}
				body += d;
				j++;
			}
			if (!closed) return { ok: false, reason: "unterminated double quote" };
			word += body;
			inWord = true;
			i = j + 1;
			continue;
		}
		word += c;
		inWord = true;
		i++;
	}
	endWord();
	if (stage.length === 0) {
		return { ok: false, reason: pipeline.length === 0 ? "empty command" : "empty pipeline stage" };
	}
	pipeline.push(stage);
	return { ok: true, pipeline };
}

// ---------------------------------------------------------------------------------------------- policy

type StageCheck = (args: string[], opts: AllowlistOptions) => string | undefined;

/** Options (and option prefixes) that make an otherwise read-only tool write files or run programs. */
function rejectOptions(args: string[], banned: string[], what: string): string | undefined {
	for (const a of args) {
		if (a === "--") break;
		for (const b of banned) {
			if (a === b || (b.startsWith("--") && a.startsWith(`${b}=`))) return `\`${what} ${b}\` is not allowed (it writes files or runs programs)`;
			// short options can be bundled: -o, -ofile, -no
			if (/^-[A-Za-z]$/.test(b) && /^-[A-Za-z]/.test(a) && !a.startsWith("--") && a.slice(1).includes(b[1])) {
				return `\`${what} ${b}\` is not allowed (it writes files or runs programs)`;
			}
		}
	}
	return undefined;
}

const readOnly: StageCheck = () => undefined;

const FIND_BANNED = ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"];

const CHECKS: Record<string, StageCheck> = {
	ls: readOnly,
	cat: readOnly,
	head: readOnly,
	tail: (args) => (args.some((a) => a === "-f" || a === "-F" || a.startsWith("--follow")) ? "`tail -f` never ends" : undefined),
	wc: readOnly,
	cut: readOnly,
	tr: readOnly,
	nl: readOnly,
	comm: readOnly,
	diff: readOnly,
	stat: readOnly,
	file: readOnly,
	du: readOnly,
	tree: (args) => rejectOptions(args, ["-o"], "tree"),
	pwd: readOnly,
	echo: readOnly,
	printf: readOnly,
	true: readOnly,
	basename: readOnly,
	dirname: readOnly,
	realpath: readOnly,
	jq: readOnly,
	grep: readOnly,
	egrep: readOnly,
	fgrep: readOnly,
	rg: (args) => rejectOptions(args, ["--pre", "--pre-glob"], "rg"),
	sort: (args) => rejectOptions(args, ["-o", "--output", "--compress-program"], "sort"),
	uniq: (args) =>
		args.filter((a) => !a.startsWith("-")).length > 1 ? "`uniq INPUT OUTPUT` writes a file; pipe into uniq instead" : undefined,
	find: (args) => {
		for (const a of args) if (FIND_BANNED.includes(a)) return `\`find ${a}\` is not allowed (it writes, deletes or runs programs)`;
		return undefined;
	},
	git: checkGit,
	gdlint: readOnly,
	gdformat: (args) =>
		args.some((a) => a === "--check" || a === "-c" || a === "--diff" || a === "-d" || /^-[a-z]*[cd][a-z]*$/.test(a))
			? undefined
			: "`gdformat` must be run with `--check` or `--diff`",
	make: checkMake,
	"pre-commit": checkPreCommit,
};

const GIT_READ_ONLY = new Set([
	"status",
	"diff",
	"log",
	"show",
	"blame",
	"annotate",
	"rev-parse",
	"rev-list",
	"merge-base",
	"ls-files",
	"ls-tree",
	"cat-file",
	"grep",
	"shortlog",
	"describe",
	"name-rev",
	"show-ref",
	"for-each-ref",
	"count-objects",
	"check-ignore",
	"check-attr",
	"whatchanged",
	"range-diff",
	"cherry",
	"diff-tree",
	"diff-index",
	"diff-files",
	"var",
	"version",
]);

const GIT_GLOBAL_OK = new Set(["--no-pager", "-P", "--literal-pathspecs", "--no-replace-objects", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"]);

const GIT_BANNED_ANYWHERE = [
	"--output",
	"--ext-diff",
	"--exec",
	"--upload-pack",
	"--receive-pack",
	"--open-files-in-pager",
	"--run",
	"--output-directory",
];

function checkGit(args: string[]): string | undefined {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		const a = args[i];
		if (GIT_GLOBAL_OK.has(a)) {
			i++;
			continue;
		}
		if (a === "-C") {
			if (args[i + 1] === undefined) return "`git -C` needs a path";
			i += 2;
			continue;
		}
		return `\`git ${a}\` is not allowed (only read-only git commands, without -c/--git-dir/--work-tree)`;
	}
	const sub = args[i];
	if (sub === undefined) return "`git` needs a subcommand";
	const rest = args.slice(i + 1);
	const dd = rest.indexOf("--");
	const opts = dd === -1 ? rest : rest.slice(0, dd);
	for (const a of opts) {
		for (const b of GIT_BANNED_ANYWHERE) {
			if (a === b || a.startsWith(`${b}=`)) return `\`git ${sub} ${b}\` is not allowed`;
		}
	}
	if (sub === "grep" && opts.some((a) => a === "-O" || /^-O./.test(a))) return "`git grep -O` runs a pager program";
	if (GIT_READ_ONLY.has(sub)) return undefined;
	const positional = opts.filter((a) => !a.startsWith("-"));
	switch (sub) {
		case "branch":
		case "tag": {
			const listOk = new Set([
				"-a",
				"--all",
				"-r",
				"--remotes",
				"-l",
				"--list",
				"-v",
				"-vv",
				"--verbose",
				"--show-current",
				"--no-color",
				"--color",
				"-n",
				"--column",
				"--no-column",
				"-i",
				"--ignore-case",
			]);
			const withValue = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]);
			let listing = false;
			for (let k = 0; k < opts.length; k++) {
				const a = opts[k];
				if (a === "-l" || a === "--list") listing = true;
				if (!a.startsWith("-")) continue;
				const name = a.split("=")[0];
				if (listOk.has(name) || /^-n\d+$/.test(a)) continue;
				if (withValue.has(name)) {
					if (!a.includes("=")) k++; // consume the value
					continue;
				}
				return `\`git ${sub} ${a}\` is not allowed (listing only)`;
			}
			const values = new Set<number>();
			for (let k = 0; k < opts.length; k++) {
				if (withValue.has(opts[k]) && !opts[k].includes("=")) values.add(k + 1);
			}
			const plain = opts.filter((a, k) => !a.startsWith("-") && !values.has(k));
			if (plain.length > 0 && !listing) return `\`git ${sub} <name>\` creates a ${sub}; only listing is allowed (use --list)`;
			return undefined;
		}
		case "remote":
			return opts.every((a) => a === "-v" || a === "--verbose") && positional.length === 0
				? undefined
				: "only `git remote -v` is allowed";
		case "config": {
			const readFlags = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--show-scope", "--name-only", "--null", "-z", "--local", "--global", "--system", "--worktree", "--includes", "--no-includes", "--type", "--bool", "--int", "--path"]);
			const reading = opts.some((a) => a === "--get" || a === "--get-all" || a === "--get-regexp" || a === "--list" || a === "-l" || a === "get" || a === "list");
			if (!reading) return "only reading git config is allowed (`git config --get`, `--list`)";
			for (const a of opts) if (a.startsWith("-") && !readFlags.has(a.split("=")[0])) return `\`git config ${a}\` is not allowed`;
			if (opts.includes("set") || opts.includes("unset") || opts.includes("edit") || opts.includes("rename-section") || opts.includes("remove-section")) {
				return "only reading git config is allowed";
			}
			return undefined;
		}
		case "stash":
			return positional[0] === "list" || positional[0] === "show" ? undefined : "only `git stash list` and `git stash show` are allowed";
		case "worktree":
			return positional[0] === "list" ? undefined : "only `git worktree list` is allowed";
		case "reflog":
			return positional[0] === "expire" || positional[0] === "delete" ? "only reading the reflog is allowed" : undefined;
		case "symbolic-ref":
			return positional.length <= 1 && !opts.some((a) => a === "-d" || a === "--delete" || a === "-m")
				? undefined
				: "only reading a symbolic ref is allowed";
		case "notes":
			return positional[0] === "list" || positional[0] === "show" ? undefined : "only `git notes list|show` is allowed";
		default:
			return `\`git ${sub}\` is not allowed: only read-only git commands (diff, log, show, status, blame, grep, ...) may run; never commit, push, amend, checkout, reset or stash`;
	}
}

function checkMake(args: string[], opts: AllowlistOptions): string | undefined {
	const targets: string[] = [];
	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		if (a === "-s" || a === "--silent" || a === "-k" || a === "--keep-going" || a === "-n" || a === "--dry-run" || a === "-q") continue;
		if (a === "-j") {
			if (/^\d+$/.test(args[k + 1] ?? "")) k++;
			continue;
		}
		if (/^-j\d*$/.test(a) || /^--jobs(=\d+)?$/.test(a)) continue;
		if (a.startsWith("-")) return `\`make ${a}\` is not allowed`;
		if (a.includes("=")) return "make variable overrides are not allowed";
		targets.push(a);
	}
	if (targets.length === 0) return `\`make\` needs one of the allowed targets: ${opts.makeTargets.join(", ") || "(none configured)"}`;
	for (const t of targets) {
		if (!opts.makeTargets.includes(t)) return `\`make ${t}\` is not an allowed target (allowed: ${opts.makeTargets.join(", ") || "none"})`;
	}
	return undefined;
}

function checkPreCommit(args: string[]): string | undefined {
	if (args[0] !== "run") return "only `pre-commit run ...` is allowed";
	const ok = new Set(["--all-files", "-a", "--files", "--hook-stage", "--show-diff-on-failure", "--verbose", "-v", "--color", "--from-ref", "--to-ref", "-s", "-o", "--source", "--origin"]);
	for (const a of args.slice(1)) {
		if (!a.startsWith("-")) continue;
		if (!ok.has(a.split("=")[0])) return `\`pre-commit run ${a}\` is not allowed`;
	}
	return undefined;
}

/** The policy decision for a whole command line. */
export function checkCommand(command: string, opts: AllowlistOptions = DEFAULT_ALLOWLIST): PolicyResult {
	const tokens = tokenize(command);
	if (!tokens.ok) return tokens;
	for (const stage of tokens.pipeline) {
		const [name, ...args] = stage;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return { ok: false, reason: "environment assignments before a command are not allowed" };
		if (name.includes("/")) return { ok: false, reason: `run commands by name, not by path (\`${name}\`)` };
		if (opts.extraCommands.includes(name)) continue;
		const check = CHECKS[name];
		if (!check) {
			return {
				ok: false,
				reason: `\`${name}\` is not on the allowlist. Allowed: read-only tools (ls, cat, head, tail, grep, rg, find, wc, sort, ...), read-only git, gdlint, gdformat --check, make ${opts.makeTargets.join("|")}, pre-commit run`,
			};
		}
		const why = check(args, opts);
		if (why) return { ok: false, reason: why };
	}
	return tokens;
}
