/**
 * bash-search-guard — bash の GNU find / grep をコマンド位置でだけ block する。
 *
 * hijoui-guard とは独立（cheap 子の explore / executor でも off にしない）。
 * 判定は lib.ts。
 *
 * なぜ文字列を除外するか: `rg "find"` や `echo "grep は禁止"` を落とすと、
 * 検索語やガード自体の説明をシェル経由で扱えなくなるため。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { inspectBashCommand } from "./lib.ts";

export default function bashSearchGuard(pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return undefined;

		const command = event.input.command;
		if (typeof command !== "string" || command.length === 0) return undefined;

		const verdict = inspectBashCommand(command);
		if (!verdict.blocked) return undefined;

		return { block: true, reason: verdict.reason };
	});

	pi.registerCommand("search-guard-check", {
		description: "bash-search-guard の判定を試す（引数を bash コマンドとして評価）",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify("usage: /search-guard-check <bash command>", "info");
				return;
			}
			const verdict = inspectBashCommand(command);
			ctx.ui.notify(
				verdict.blocked ? `BLOCK (${verdict.command})\n${verdict.reason}` : "ALLOW",
				"info",
			);
		},
	});
}
