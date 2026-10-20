/**
 * session-title — 最初のユーザープロンプトから「今何をしているか」の日本語1行説明を
 * チープモデル（~/.pi/agent/cheap-model.json）で生成し、
 * セッション名（setSessionName）に反映する。resume 時は既存名を使うだけ。
 * 失敗しても本体セッションは壊さない（失敗時は名前を付けず、次の interactive 入力で再試行）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { readCurrent } from "./cheap-model.ts";

const TITLE_TIMEOUT_MS = 15_000;
const MAX_TITLE_LEN = 80;
// 再試行の上限（失敗が続くと毎入力で子 pi が立つため）
const MAX_TITLE_ATTEMPTS = 2;

/** モデル出力から1行タイトルを取り出す（引用符・空行を除去） */
function normalizeTitle(raw: string): string {
	const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
	const cleaned = line.replace(/^["'「『]+|["'」』]+$/g, "").trim();
	return cleaned.slice(0, MAX_TITLE_LEN);
}

/** pi --mode json の stdout から最後の assistant テキストを取り出す */
function extractTitleFromJsonOutput(stdout: string): string | null {
	let title: string | null = null;
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let event: {
			type?: string;
			message?: { role?: string; content?: { type?: string; text?: string }[] };
		};
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const text = (event.message.content ?? [])
				.filter((p) => p.type === "text")
				.map((p) => p.text ?? "")
				.join("")
				.trim();
			if (text) title = text;
		}
	}
	return title;
}

/** このプロセスから pi CLI を起動するための実行ファイル解決（subagent example 踏襲） */
function getPiInvocation(): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args: [] };
	}
	return { command: "pi", args: [] };
}

function titlePrompt(text: string): string {
	return [
		"あなたはセッションタイトル生成器。ユーザーの最初のプロンプトから、このセッションで「今何をしているか」を表す日本語の1行説明を作れ。",
		"ルール: 40〜70字程度（上限80字）の日本語1文。主語なしで作業内容を述べること。",
		"禁止: ブランチ名・kebab-case・ファイル名・コマンド・単語の列挙だけの出力（例: 「fix-bug」「foo.ts」「バグ修正、スタイル調整、リファクタ」は不可）。",
		"例: 「未読時だけ両タブに数字なしドットを出し、入場で消灯する」「ログイン画面で入力値を検証し、エラー時は項目ごとに赤字で表示する」",
		"タイトルのみ出力（説明・引用符・改行なし）。",
		"",
		`プロンプト: ${text}`,
	].join("\n");
}

export default function sessionTitle(pi: ExtensionAPI) {
	/** 一度だけ生成する（/new・fork の session_start でリセット） */
	let titled = false;
	/** 生成実行中（実行中のみ二重生成を防ぐ。失敗時は titled にならず次の入力で再試行） */
	let generating = false;
	/** 失敗した試行回数（上限 MAX_TITLE_ATTEMPTS に達したら再試行しない） */
	let failedAttempts = 0;

	pi.on("session_start", (event) => {
		// /new・fork でセッションが替わったら再生成可能に戻す
		if (event.reason === "new" || event.reason === "fork") {
			titled = false;
			generating = false;
			failedAttempts = 0;
		}
	});

	pi.on("input", (event, ctx) => {
		// 子 pi（--mode json -p）や rpc では何もしない（再帰防止）
		if (ctx.mode !== "tui") return { action: "continue" };
		if (titled || generating || failedAttempts >= MAX_TITLE_ATTEMPTS) return { action: "continue" };
		// 最初の interactive 入力のみ。steer / followUp は割り込み・追加入力なので対象外
		if (event.source !== "interactive" || event.streamingBehavior) return { action: "continue" };

		// resume / ユーザー命名済み: 本体が • 名を出すので再生成しない
		if (pi.getSessionName()) {
			titled = true;
			return { action: "continue" };
		}

		// 生成は fire-and-forget（await すると初回プロンプトが最大15秒ブロックされる）
		generating = true;
		void (async () => {
			try {
				const cheap = readCurrent();
				if (cheap) {
					const invocation = getPiInvocation();
					const res = await pi.exec(
						invocation.command,
						[
							...invocation.args,
							"--mode",
							"json",
							"-p",
							"--no-session",
							// 子に extension をロードしない（無いと print-mode でも input が
							// interactive 扱いになり、この extension が再ロードされて再帰する）
							"--no-extensions",
							"--no-skills",
							"--no-prompt-templates",
							"--model",
							`${cheap.provider}/${cheap.model}`,
							titlePrompt(event.text),
						],
						{ timeout: TITLE_TIMEOUT_MS },
					);
					if (res.code === 0) {
						const raw = extractTitleFromJsonOutput(res.stdout);
						const title = raw ? normalizeTitle(raw) : "";
						if (title) {
							pi.setSessionName(title);
							titled = true;
							return;
						}
					}
				}
				failedAttempts += 1;
			} catch {
				/* 失敗 → 名前を付けない。上限まで次の interactive 入力で再試行 */
				failedAttempts += 1;
			} finally {
				generating = false;
			}
		})();

		return { action: "continue" };
	});
}
