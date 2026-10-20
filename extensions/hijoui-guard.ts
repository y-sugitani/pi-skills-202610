/**
 * hijoui-guard — 親セッションが作業ツールを使う前に `非委譲: <code>` を強制する。
 *
 * - explore / executor 等の cheap 子は無効
 * - 委譲の起動・監督ツールは宣言なしで可
 * - 委譲用 skill の read だけは宣言なしで可
 * - それ以外の調査・実装ツールは同一ユーザーターン内の宣言が必要
 *
 * 許可リストは _shared/hijoui-allowlist.ts に集約。
 * 無効化: PI_HIJOUIGUARD=off、または agent dir の hijoui-guard.json で {"enabled": false}。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ALWAYS_ALLOW_TOOLS,
	CODE_RE,
	DELEGATE_BASH_RE,
	DELEGATION_READ_PATH_RE,
	type HijouiCode,
	isHijouiGuardDisabled,
	VALID_CODES,
} from "./_shared/hijoui-allowlist.ts";

const CHEAP_CHILD_PROMPT_RE =
	/調査専用のサブエージェント|実装実行専用のサブエージェント|あなたは調査専用|あなたは実装実行専用/;

const BLOCK_REASON = [
	"hijoui-guard: 非委譲宣言が無い。",
	"自分で調査・実装するなら、同一応答のテキストに先に `非委譲: <code>` を書け。",
	`許可 code: ${VALID_CODES.join(" | ")}。`,
	"委譲するなら宣言不要で spawn_cheap / subagent / mux-pi spawn-agent を使え。",
	"委譲用 skill（delegate-execute 等）の read と監督ツール（lane_watch / timer_*）は宣言なしで可。",
	"このガード自体を外すなら PI_HIJOUIGUARD=off（または agent dir の hijoui-guard.json に {\"enabled\": false}）。",
].join(" ");

type BranchEntry = {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function isCheapChild(ctx: ExtensionContext): boolean {
	try {
		const prompt = ctx.getSystemPrompt?.() ?? "";
		if (CHEAP_CHILD_PROMPT_RE.test(prompt)) return true;
		// replace 系子は「再委譲しない」+ サブエージェント定型が多い
		if (prompt.includes("再委譲しない") && prompt.includes("サブエージェント")) return true;
	} catch {
		/* ignore */
	}
	const parent = process.env.PI_SUBAGENT_PARENT_SESSION;
	const self = process.env.PI_SESSION_ID;
	if (parent && self && parent !== self) return true;
	return false;
}

function findHijouiCode(ctx: ExtensionContext): HijouiCode | null {
	let branch: BranchEntry[] = [];
	try {
		branch = ctx.sessionManager.getBranch() as BranchEntry[];
	} catch {
		return null;
	}

	const texts: string[] = [];
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role === "user") break;
		if (role === "assistant") {
			texts.push(textFromContent(entry.message.content));
		}
	}

	const joined = texts.reverse().join("\n");
	const m = joined.match(CODE_RE);
	if (!m) return null;
	const code = m[1] as HijouiCode;
	return VALID_CODES.includes(code) ? code : null;
}

function pathLooksLikeDelegationSkill(path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	return DELEGATION_READ_PATH_RE.test(normalized);
}

function isAllowedWithoutDeclaration(toolName: string, input: Record<string, unknown>): boolean {
	if (ALWAYS_ALLOW_TOOLS.has(toolName)) return true;

	if (toolName === "read") {
		const path = typeof input.path === "string" ? input.path : "";
		return path.length > 0 && pathLooksLikeDelegationSkill(path);
	}

	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		return command.length > 0 && DELEGATE_BASH_RE.test(command);
	}

	return false;
}

function inputAsRecord(input: unknown): Record<string, unknown> {
	return isRecord(input) ? input : {};
}

export default function hijouiGuard(pi: ExtensionAPI) {
	let childSession = false;
	let disabled = false;

	const refreshMode = (ctx: ExtensionContext) => {
		disabled = isHijouiGuardDisabled();
		childSession = !disabled && isCheapChild(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		refreshMode(ctx);
		// 旧バージョンのフッタが残っていれば消す
		try {
			ctx.ui.setStatus("hijoui-guard", undefined);
		} catch {
			/* ignore */
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		refreshMode(ctx);
		if (disabled || childSession) return undefined;

		const tip = [
			"",
			"## hijoui-guard（機械的）",
			"親が read/bash/edit/write/grep/find/ls や MCP 等の作業ツールを使うには、",
			"同一ユーザーターンのアシスタント出力に `非委譲: user-forbid|decision-only|tiny-patch|meta|skill|design-write` が必要。",
			"委譲するなら宣言不要。spawn_cheap / subagent / mux-pi で explore|executor を出せ。",
			"宣言なしで可: 委譲用 skill の read、spawn_cheap / lane_watch / timer_* / herdr_* / subagent* / bg_wait / contact_supervisor / mux_intervene / mux_close。",
			"無効化: PI_HIJOUIGUARD=off（または agent dir の hijoui-guard.json に {\"enabled\": false}）。",
		].join("\n");

		return {
			systemPrompt: `${event.systemPrompt}${tip}`,
		};
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (disabled) disabled = isHijouiGuardDisabled();
		if (!disabled && !childSession) childSession = isCheapChild(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (disabled) disabled = isHijouiGuardDisabled();
		if (disabled) return undefined;
		if (childSession || isCheapChild(ctx)) {
			childSession = true;
			return undefined;
		}

		const toolName = event.toolName;
		const input = inputAsRecord(event.input);

		if (isAllowedWithoutDeclaration(toolName, input)) {
			return undefined;
		}

		const code = findHijouiCode(ctx);
		if (code) return undefined;

		return {
			block: true,
			reason: BLOCK_REASON,
		};
	});

	pi.registerCommand("hijoui-status", {
		description: "非委譲ガードの状態（宣言 code / child-off / disabled）",
		handler: async (_args, ctx) => {
			refreshMode(ctx);
			const code = childSession || disabled ? null : findHijouiCode(ctx);
			const lines = [
				`active: ${disabled ? "off (disabled)" : childSession ? "off (cheap child)" : "on (parent)"}`,
				`declaration: ${code ?? "(none)"}`,
				`valid: ${VALID_CODES.join(", ")}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
