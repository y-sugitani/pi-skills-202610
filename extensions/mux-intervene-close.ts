/**
 * mux-intervene-close — レーン割り込み / 枠閉じの Pi ツール（Herdr 専用）。
 *
 * mux-pi（skills/mux-pi/scripts、パッケージ内）の intervene.sh / close.sh を包む。
 * モデルに生の send_text を書かせないための受け口（force+ack はスクリプト側の正本どおり）。
 * detect はスクリプト内部で呼ばれる。lane-supervisor は触らない。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { clearIntervening, markIntervening } from "./lane-supervisor/intervene-state.ts";
import { extractAgentStatus, formatParentEvent } from "./lane-supervisor/lib.ts";
import { muxScript } from "./_shared/paths.ts";

const HERDR_OUTSIDE_HINT =
	"mux_intervene / mux_close は Herdr 専用。" +
	"Herdr 外は subagent ツールを async: true で使い、追加指示は subagent の完了・中断で扱う。";

const SCRIPTS_MISSING = {
	ok: false,
	error: "mux_pi_not_found",
	hint: "パッケージ内の skills/mux-pi/scripts が見つからない（配布物が欠けている）",
};

function textResult(ok: boolean, obj: Record<string, unknown>, details: Record<string, unknown>) {
	return {
		content: [{ type: "text", text: JSON.stringify(obj) }],
		details: { ok, ...details },
	};
}

function parseJson(text: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(text);
		return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export default function muxInterveneClose(pi: ExtensionAPI) {
	pi.registerTool({
		name: "mux_intervene",
		label: "Mux Intervene",
		description:
			"走行中レーン / 子 pi へ割り込み指示を送る（mux-pi intervene.sh を包む。force+ack 正本・中断挿入・Herdr 専用）。" +
			"herdr pane send_text の生送信は禁止のため、必ずこのツールを使う。",
		promptSnippet: "レーン / 子 pi への割り込み・追加指示（force+ack・中断挿入）。生 send_text 禁止。",
		promptGuidelines: [
			"子/レーンへの指示・割り込みは mux_intervene を使う（herdr pane send_text の生送信は禁止）。",
			"force は既定 true（working 中は esc → prompt で中断して挿入）。force=false / herdr_agent prompt はキュー積み。安委譲の親介入は force=true のみ。",
			"メッセージは短く 1 件。長文は message_file に書いて渡す。",
		],
		parameters: Type.Object({
			agent: Type.String({ description: "herdr agent 名（spawn_cheap / spawn-agent.sh の JSON の agent）" }),
			message: Type.Optional(
				Type.String({ description: "短い指示 1 件（message_file と排他。両方あれば message 優先）" }),
			),
			message_file: Type.Optional(Type.String({ description: "長文メッセージのファイルパス" })),
			force: Type.Optional(Type.Boolean({ description: "true=中断して挿入（esc→prompt、default）。false=キュー積み。安委譲の親介入は true のみ" })),
		}),
		async execute(_toolCallId, args, _signal, _onUpdate, _ctx) {
			// 介入終了直後の herdr agent get で idle/done なら CHEAP_EVENT completion を親へ。
			// 介入中（mark 〜 clear）は lane-supervisor が cheap settled を抑止するので、
			// この 1 回だけが「介入後にまだ idle/done のとき」を拾う経路（時間猶予なし）。
			const deliverInterveneResult = (agent: string): void => {
				void (async () => {
					const res = await pi.exec("herdr", ["agent", "get", agent], { timeout: 15_000 });
					const status = res.code === 0 ? extractAgentStatus(res.stdout) : null;
					if (status !== "idle" && status !== "done") return; // working/blocked: armWait が次の settled を拾う
					const text = formatParentEvent({
						kind: "cheap",
						signal: "completion",
						agent,
						from: "working",
						to: status,
						reason: "settled",
						verdict: "completion",
						summary: "intervene 終了後も settled — 親へ completion",
					});
					pi.sendUserMessage(text, { deliverAs: "followUp" });
				})();
			};

			const interveneSh = muxScript("intervene.sh");
			if (!interveneSh) {
				return textResult(false, SCRIPTS_MISSING, { ok: false, error: "mux_pi_not_found" });
			}
			if (process.env.HERDR_ENV !== "1") {
				return textResult(
					false,
					{ ok: false, error: "herdr_required", hint: HERDR_OUTSIDE_HINT },
					{ ok: false, error: "herdr_required" },
				);
			}
			const agent = (args.agent ?? "").trim();
			if (!agent) {
				return textResult(
					false,
					{ ok: false, error: "agent_required", hint: "agent（herdr agent 名）が空" },
					{ ok: false, error: "agent_required" },
				);
			}
			const message = (args.message ?? "").trim();
			const messageFile = (args.message_file ?? "").trim();
			if (!message && !messageFile) {
				return textResult(
					false,
					{ ok: false, error: "message_required", hint: "message または message_file が必要" },
					{ ok: false, error: "message_required" },
				);
			}

			const scriptArgs = ["--agent", agent];
			if (message) scriptArgs.push("--message", message);
			if (messageFile) scriptArgs.push("--message-file", messageFile);
			const force = args.force !== false;
			scriptArgs.push(force ? "--force" : "--no-force");

			// 介入中 = force=true の execute 入場〜return（成功でも失敗でも）。
			// この間の cheap settled（esc 由来の一時 idle）は CHEAP_EVENT completion にしない。
			if (force) markIntervening(agent);
			let res;
			try {
				res = await pi.exec("bash", [interveneSh, ...scriptArgs], {
					timeout: 90_000,
				});
			} finally {
				if (force) clearIntervening(agent);
			}
			if (res.code !== 0) {
				const err = parseJson(res.stderr) ?? {};
				return textResult(
					false,
					{ ok: false, ...err, detail: (res.stderr || res.stdout).trim().slice(0, 800) },
					{ ok: false, ...err },
				);
			}
			const out = parseJson(res.stdout) ?? { ok: true };
			if (force) deliverInterveneResult(agent);
			return textResult(true, out, { ok: true, agent, intervened: out.intervened === true });
		},
	});

	pi.registerTool({
		name: "mux_close",
		label: "Mux Close",
		description:
			"レーン枠 / 委譲 pane を閉じる（mux-pi close.sh を包む・Herdr 専用）。司令塔の tab/window/pane はスクリプトが拒否する。",
		promptSnippet: "レーン枠 / 委譲 pane を閉じる（司令塔枠は拒否）。",
		promptGuidelines: [
			"枠を閉じる前に lane_unwatch（撤収順: lane_unwatch → mux_close → worktree remove）。",
			"司令塔自身の tab / pane は close.sh が拒否する（refusing_close_*）。",
		],
		parameters: Type.Object({
			tab: Type.Optional(Type.String({ description: "herdr tab id（レーン枠）" })),
			pane: Type.Optional(Type.String({ description: "herdr pane id（安委譲の下ペイン）" })),
		}),
		async execute(_toolCallId, args, _signal, _onUpdate, _ctx) {
			const closeSh = muxScript("close.sh");
			if (!closeSh) {
				return textResult(false, SCRIPTS_MISSING, { ok: false, error: "mux_pi_not_found" });
			}
			if (process.env.HERDR_ENV !== "1") {
				return textResult(
					false,
					{ ok: false, error: "herdr_required", hint: HERDR_OUTSIDE_HINT },
					{ ok: false, error: "herdr_required" },
				);
			}
			const tab = (args.tab ?? "").trim();
			const pane = (args.pane ?? "").trim();
			if (!tab && !pane) {
				return textResult(
					false,
					{ ok: false, error: "target_required", hint: "tab / pane のいずれかが必要" },
					{ ok: false, error: "target_required" },
				);
			}

			const scriptArgs: string[] = [];
			if (tab) scriptArgs.push("--tab", tab);
			if (pane) scriptArgs.push("--pane", pane);

			const res = await pi.exec("bash", [closeSh, ...scriptArgs], {
				timeout: 30_000,
			});
			if (res.code !== 0) {
				const err = parseJson(res.stderr) ?? {};
				return textResult(
					false,
					{ ok: false, ...err, detail: (res.stderr || res.stdout).trim().slice(0, 800) },
					{ ok: false, ...err },
				);
			}
			const out = parseJson(res.stdout) ?? { ok: true };
			return textResult(true, out, { ok: true, ...out });
		},
	});
}
