/**
 * /start-lane — 自 repo の司令塔運用を開始する（Herdr 専用）。
 * Herdr なら自タブを main repo 名に改名してから、lane-control の汎用プロンプトを流す。
 * Herdr 外は lane_watch / mux_* が使えないため、案内だけ返す。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { startLanePromptPath } from "./_shared/paths.ts";

const OUTSIDE_HERDR_HINT =
	"start-lane は Herdr 専用（lane_watch / mux_intervene / mux_close が Herdr を要求する）。" +
	"Herdr 外は subagent ツールを async: true で使い、委譲ごとに完了通知で結果を受け取る運用にする。";

function stripFrontmatter(md: string): string {
	if (!md.startsWith("---")) return md;
	const end = md.indexOf("\n---", 3);
	if (end < 0) return md;
	return md.slice(end + 4).replace(/^\s+/, "");
}

/** worktree でも main repo 名（git-common-dir の親）。git でなければ cwd basename。 */
async function repoName(pi: ExtensionAPI, cwd: string): Promise<string> {
	try {
		const res = await pi.exec(
			"bash",
			[
				"-lc",
				'cd "$1" || exit 1; common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 1; case "$common" in /*) gitdir="$common" ;; *) gitdir="$(pwd)/$common" ;; esac; gitdir=$(cd "$gitdir" 2>/dev/null && pwd) || exit 1; if [ "$(basename "$gitdir")" = ".git" ]; then basename "$(dirname "$gitdir")"; else git rev-parse --show-toplevel | xargs basename; fi',
				"sh",
				cwd,
			],
			{ timeout: 10_000 },
		);
		const name = (res.stdout ?? "").trim().split("\n").pop() ?? "";
		if (name) return name;
	} catch {
		/* git 失敗 → cwd basename */
	}
	return basename(cwd);
}

export default function startLane(pi: ExtensionAPI) {
	pi.registerCommand("start-lane", {
		description:
			"自 repo の progress を正本にレーン制御を開始（Herdr 専用）。自タブを repo 名に改名。任意で [メモ]",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			if (process.env.HERDR_ENV !== "1") {
				ctx.ui.notify(`start-lane: ${OUTSIDE_HERDR_HINT}`, "warning");
				return;
			}

			const repo = await repoName(pi, ctx.cwd);
			const tabId = process.env.HERDR_TAB_ID;

			let renamed = false;
			if (tabId) {
				try {
					const res = await pi.exec("herdr", ["tab", "rename", tabId, repo], { timeout: 15_000 });
					renamed = res.code === 0;
				} catch {
					renamed = false;
				}
			}

			const promptFile = startLanePromptPath();
			if (!promptFile) {
				ctx.ui.notify(
					"start-lane: プロンプトが見つからない（パッケージ内 skills/lane-control/prompts/start-lane.md）",
					"error",
				);
				return;
			}
			let prompt: string;
			try {
				prompt = stripFrontmatter(readFileSync(promptFile, "utf8"));
			} catch {
				ctx.ui.notify(`start-lane: プロンプトの読み込みに失敗（${promptFile}）`, "error");
				return;
			}
			const memo = args.trim();
			if (memo) {
				prompt += `\n\n## ユーザーメモ\n${memo}`;
			}

			ctx.ui.notify(
				renamed
					? `タブを "${repo}" に改名。レーン制御を開始`
					: `タブ改名に失敗（repo=${repo}）。レーン制御は続行`,
				renamed ? "info" : "warning",
			);
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		},
	});
}
