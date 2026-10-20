/**
 * spawn-cheap — 安いサブエージェント（explore / executor）の起動ツール。
 *
 * mux-pi（skills/mux-pi/scripts、パッケージ内）の detect.sh / spawn-agent.sh を包む。
 * Herdr 内は pane 経路のみ（--layout pane・--wait なし）。in-process は Herdr 内で禁止のため、
 * この拡張が subagent / subagent_wait を HERDR_ENV=1 で拒否する（コードで固定）。
 * 完了監督は lane-supervisor の lane_watch（本ツールは agent / pane を返すだけ）。
 * Herdr 外は herdr_only + subagent（async）の使い方を返す（in-process は subagent ツール側の役割）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cheapModelOverride } from "./_shared/cheap-model-config.ts";
import { muxScript } from "./_shared/paths.ts";

const VALID_AGENTS = new Set(["explore", "executor"]);

export { cheapModelOverride };

const SPAWN_TIMEOUT_MS = 180_000;

function errText(e: unknown): string {
	if (e == null) return "unknown error";
	if (typeof e === "string") return e;
	if (e instanceof Error) return e.message;
	try {
		return JSON.stringify(e).slice(0, 400);
	} catch {
		return String(e);
	}
}

const HERDR_OUTSIDE_HINT =
	"spawn_cheap は Herdr 内専用（pane 経路・in-process 禁止）。" +
	"Herdr 外は subagent ツールを async: true で呼び、委譲 → 完了時に通知を受ける形で使う" +
	"（例: subagent({ agent: \"executor\", task: \"...\", async: true })）。" +
	"同時稼働は最大 2、結果は戻ったら review を読んでから完了を言う。";

function textResult(ok: boolean, obj: Record<string, unknown>, details: Record<string, unknown>) {
	return {
		content: [{ type: "text", text: JSON.stringify(obj) }],
		details: { ok, ...details },
	};
}

export default function spawnCheap(pi: ExtensionAPI) {
	// Herdr 内は in-process 禁止（例外なし）。subagent / subagent_wait を拒否する。
	pi.on("tool_call", async (event) => {
		if (process.env.HERDR_ENV !== "1") return undefined;
		if (event.toolName === "subagent" || event.toolName === "subagent_wait") {
			return {
				block: true,
				reason:
					"spawn-cheap: Herdr 内（HERDR_ENV=1）は in-process 禁止（例外なし）。" +
					"subagent の代わりに spawn_cheap ツール（pane 経路・--wait なし）を使い、直後 lane_watch。",
			};
		}
		return undefined;
	});

	pi.registerTool({
		name: "spawn_cheap",
		label: "Spawn Cheap",
		description:
			"Herdr 内で安いサブエージェント（explore / executor）を pane 起動する（mux-pi spawn-agent.sh --layout pane を包む）。" +
			"in-process はしない（Herdr 内は禁止・ツールが拒否）。Herdr 外は herdr_only と subagent（async）の使い方を返す。",
		promptSnippet: "Herdr 内の安委譲起動（pane 経路・in-process 禁止・--wait なし）。直後 lane_watch。",
		promptGuidelines: [
			"Herdr 内（HERDR_ENV=1）で explore / executor を起動するときは spawn_cheap を使う。subagent（in-process）は禁止（このツールが拒否する）。",
			"spawn_cheap は --wait しない。成功 JSON の agent で直後 lane_watch（kind=cheap, label=cheap-<title>。拡張内 safety/periodic はオフ）。親は同時に timer_start の cheap-main（300s 定期）を回す。介入は mux_intervene force=true（中断挿入）。",
			"止まったら delegate-execute の閉じる判定。通っても枠を閉じる前に review を read しレビュー節。未実施のまま完了を言うな。通ったら lane_unwatch → mux_close pane。",
			"Herdr 外は herdr_only を返す。その場合は subagent ツールを async: true で呼ぶ（例: subagent({ agent: \"executor\", task, async: true })）。",
			"同時稼働は最大 2。advisor はここで起動しない。",
		],
		parameters: Type.Object({
			agent: Type.Optional(
				Type.String({
					description: "explore | executor（default executor）",
				}),
			),
			task: Type.String({ description: "委譲プロンプト（delegate-execute 形: 目的・完了条件・制約）" }),
			title: Type.Optional(
				Type.String({ description: "pane / agent 名（default: agent 名）。lane_watch の label にも使う" }),
			),
			workdir: Type.Optional(Type.String({ description: "作業ディレクトリ（default: 現在の cwd）" })),
			model: Type.Optional(
				Type.String({
					description:
						"model 上書き。無ければ cheap-model.json（/cheap-model で model+thinking を選択。thinking ありなら provider/model:thinking を渡す）→ それも無ければ agent 定義の model:",
				}),
			),
		}),
		async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
			const detectSh = muxScript("detect.sh");
			const spawnSh = muxScript("spawn-agent.sh");
			if (!detectSh || !spawnSh) {
				return textResult(
					false,
					{
						ok: false,
						error: "mux_pi_not_found",
						hint: "パッケージ内の skills/mux-pi/scripts が見つからない（配布物が欠けている）",
					},
					{ ok: false, error: "mux_pi_not_found" },
				);
			}

			const agent = (args.agent ?? "executor").trim();
			if (!VALID_AGENTS.has(agent)) {
				return textResult(
					false,
					{
						ok: false,
						error: "bad_agent",
						valid: [...VALID_AGENTS],
						hint: `agent は ${[...VALID_AGENTS].join(" | ")}`,
					},
					{ ok: false, error: "bad_agent", agent },
				);
			}
			const task = (args.task ?? "").trim();
			if (!task) {
				return textResult(
					false,
					{ ok: false, error: "task_required", hint: "task（委譲プロンプト）が空" },
					{ ok: false, error: "task_required" },
				);
			}
			const title = (args.title ?? agent).trim() || agent;

			// backend 検出（detect.sh を包む。HERDR_ENV=1 → herdr）
			const detect = await pi.exec("bash", [detectSh], { timeout: 15_000 });
			let backend = "unknown";
			try {
				backend = JSON.parse(detect.stdout).backend ?? "unknown";
			} catch {
				/* fall through */
			}
			if (backend !== "herdr") {
				return textResult(
					false,
					{
						ok: false,
						error: "herdr_only",
						backend,
						hint: HERDR_OUTSIDE_HINT,
					},
					{ ok: false, error: "herdr_only", backend },
				);
			}

			// spawn-agent.sh は --task-file 必須。task を一時ファイルへ書く。
			const taskFile = join(
				tmpdir(),
				`task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
			);
			try {
				writeFileSync(taskFile, task, "utf8");
			} catch (e) {
				return textResult(
					false,
					{ ok: false, error: "task_write_failed", detail: errText(e) },
					{ ok: false, error: "task_write_failed" },
				);
			}

			const spawnArgs = [
				"--agent",
				agent,
				"--layout",
				"pane",
				"--title",
				title,
				"--task-file",
				taskFile,
				"--workdir",
				args.workdir?.trim() || ctx.cwd,
			];
			const modelOverride = args.model?.trim() || cheapModelOverride();
			if (modelOverride) spawnArgs.push("--model", modelOverride);

			const res = await pi.exec("bash", [spawnSh, ...spawnArgs], {
				timeout: SPAWN_TIMEOUT_MS,
			});
			if (res.code !== 0) {
				return textResult(
					false,
					{
						ok: false,
						error: "spawn_failed",
						code: res.code,
						detail: (res.stderr || res.stdout).trim().slice(0, 800),
						hint: "spawn-agent.sh の失敗。detail を確認。",
					},
					{ ok: false, error: "spawn_failed", code: res.code },
				);
			}

			let out: Record<string, unknown>;
			try {
				out = JSON.parse(res.stdout);
			} catch {
				return textResult(
					false,
					{ ok: false, error: "bad_spawn_output", detail: res.stdout.slice(0, 400) },
					{ ok: false, error: "bad_spawn_output" },
				);
			}
			const agentName = typeof out.agent === "string" ? out.agent : agent;
			const paneId = typeof out.pane_id === "string" ? out.pane_id : "";
			const status = typeof out.agent_status === "string" ? out.agent_status : "unknown";
			return textResult(
				true,
				{
					ok: true,
					backend: "herdr",
					agent: agentName,
					pane_id: paneId,
					tab_id: out.tab_id ?? null,
					task_file: taskFile,
					prompt_attempts: out.prompt_attempts ?? null,
					agent_status: status,
					next: `lane_watch agent=${agentName} kind=cheap label=cheap-${title}（safety/periodic オフ）+ timer_start cheap-main 300s。介入は mux_intervene force=true。止まったら delegate-execute の閉じる判定。通っても枠を閉じる前に review を read しレビュー節。未実施のまま完了を言うな。通ったら lane_unwatch → mux_close pane`,
				},
				{ ok: true, agent: agentName, pane_id: paneId, agent_status: status },
			);
		},
	});
}
