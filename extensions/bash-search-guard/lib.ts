/**
 * bash-search-guard の判定ロジック（Pi / I/O 非依存・テスト対象）。
 *
 * - コマンド位置（先頭・|・&&・||・;・$()・バッククォート・/usr/bin/find 等）だけを見る
 * - 文字列・コメント内の語は対象外（shell の引用を追ってマスクしてから走査する）
 * - fd / rg は通す。grep は egrep / fgrep も同扱い
 */

const BLOCKED_COMMANDS = new Set(["find", "grep", "egrep", "fgrep"]);

/** 直後の語がコマンド位置になる語。位置をずらすだけなので、その語自体は対象外。 */
const TRANSPARENT_WORDS = new Set([
	"sudo",
	"doas",
	"env",
	"command",
	"exec",
	"nohup",
	"nice",
	"ionice",
	"stdbuf",
	"setsid",
	"time",
	"if",
	"then",
	"else",
	"elif",
	"while",
	"until",
	"do",
	"done",
	"!",
]);

/** `-u root` のように値も食う wrapper option（素通しさせないため値ごと読み飛ばす） */
const VALUE_TAKING_OPTS = new Set([
	"-u",
	"-g",
	"-p",
	"-C",
	"-h",
	"-r",
	"-t",
	"-U",
	"-n",
	"-c",
	"-o",
	"-e",
	"-f",
	"--user",
	"--group",
	"--prompt",
	"--chdir",
	"--host",
	"--role",
	"--type",
	"--other-user",
	"--nice",
	"--class",
	"--pid",
	"--format",
	"--output",
	"--unset",
]);

/** `/usr/bin/find` のようなシステム側のパスだけをコマンド名として扱う（`./find` はローカル script なので除外） */
const SYSTEM_BIN_DIR_RE = /^\/(?:usr\/(?:local\/)?bin|bin|sbin|usr\/sbin|opt\/homebrew\/bin)\//;

const REDIRECT_RE = /^(?:\d*(?:>>|>|<)|&>>?|\d*>&\d*|&<\d*)$/;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export type SearchGuardVerdict =
	| { blocked: false }
	| { blocked: true; command: string; reason: string };

function isRedirectOp(token: string): boolean {
	return REDIRECT_RE.test(token);
}

function isAssignment(token: string): boolean {
	return ASSIGNMENT_RE.test(token);
}

/** コマンド語 → 判定する名前。path・先頭 backslash を剥がす。判定対象外なら null。 */
function commandName(token: string): string | null {
	const raw = token.replace(/^\\+/, "");
	if (!raw) return null;
	if (!raw.includes("/")) return raw;
	if (!SYSTEM_BIN_DIR_RE.test(raw)) return null;
	const base = raw.slice(raw.lastIndexOf("/") + 1);
	return base || null;
}

/**
 * shell の引用を追い、コードとして実行されない部分を空白に置き換える。
 * `"..."` / `'...'` の中身と `#` コメントは消し、`$()` とバッククォートの中は
 * 実行されるので残す（区切りとして `(` / `;` を差し込む）。
 */
export function maskNonCode(command: string): string {
	const out: string[] = Array.from(command, () => " ");
	let i = 0;

	const atCommentStart = (pos: number) =>
		pos === 0 || /[\s;&|(){}]/.test(command[pos - 1] ?? "");

	const scanSingle = () => {
		i++; // 開き quote
		while (i < command.length) {
			if (command[i] === "'") {
				i++;
				return;
			}
			i++;
		}
	};

	const scanDouble = () => {
		i++; // 開き quote
		while (i < command.length) {
			const c = command[i]!;
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === '"') {
				i++;
				return;
			}
			if (c === "`") {
				out[i] = ";";
				i++;
				scanCode("`");
				continue;
			}
			if (c === "$" && command[i + 1] === "(") {
				out[i] = "(";
				i += 2;
				scanCode(")");
				continue;
			}
			i++;
		}
	};

	const scanCode = (stop: ")" | "`" | null) => {
		while (i < command.length) {
			const c = command[i]!;
			if (stop === ")" && c === ")") {
				i++;
				return;
			}
			if (stop === "`" && c === "`") {
				i++;
				return;
			}
			if (c === "\\") {
				out[i] = c;
				i++;
				if (i < command.length) {
					out[i] = command[i]!;
					i++;
				}
				continue;
			}
			if (c === "'") {
				scanSingle();
				continue;
			}
			if (c === '"') {
				scanDouble();
				continue;
			}
			if (c === "`") {
				out[i] = ";";
				i++;
				scanCode("`");
				continue;
			}
			if (c === "$" && command[i + 1] === "(") {
				out[i] = "(";
				i += 2;
				scanCode(")");
				continue;
			}
			if (c === "$" && command[i + 1] === "'") {
				i++; // $'...' の中身は文字列
				scanSingle();
				continue;
			}
			if (c === "#" && atCommentStart(i)) {
				const nl = command.indexOf("\n", i);
				i = nl < 0 ? command.length : nl;
				continue;
			}
			out[i] = c;
			i++;
		}
	};

	scanCode(null);
	return out.join("");
}

function reasonFor(name: string, command: string): string {
	const shown = command.length > 200 ? `${command.slice(0, 200)}…` : command;
	return [
		`bash-search-guard: bash から ${name} を実行しない。`,
		`検出: ${shown}`,
		"代替: ファイル名・内容探索は Pi ツールの find / grep（fffind / ffgrep）、シェルで絞るなら fd / rg。",
		"（fd -e ts / rg -n pattern のように使う）",
	].join(" ");
}

/** bash の command 文字列から、コマンド位置の find / grep を検出する。 */
export function inspectBashCommand(command: string): SearchGuardVerdict {
	const masked = maskNonCode(command);

	for (const segment of masked.split(/[|&;\n(){}]+/)) {
		const tokens = segment.trim().split(/\s+/).filter((t) => t.length > 0);
		let idx = 0;

		while (idx < tokens.length) {
			const token = tokens[idx]!;

			if (isRedirectOp(token)) {
				idx += 2; // 直後の語はリダイレクト先のファイル名
				continue;
			}
			if (isAssignment(token)) {
				idx += 1;
				continue;
			}

			const name = commandName(token);
			if (name && TRANSPARENT_WORDS.has(name)) {
				// `command -v find` は存在確認なので通す
				if (name === "command" && /^-[vV]$/.test(tokens[idx + 1] ?? "")) break;
				idx += 1;
				while (idx < tokens.length && tokens[idx]!.startsWith("-")) {
					idx += VALUE_TAKING_OPTS.has(tokens[idx]!) ? 2 : 1;
				}
				continue;
			}

			if (name && BLOCKED_COMMANDS.has(name)) {
				return { blocked: true, command: name, reason: reasonFor(name, command) };
			}
			break; // 最初に来た「コマンドらしい語」で確定
		}
	}

	return { blocked: false };
}
