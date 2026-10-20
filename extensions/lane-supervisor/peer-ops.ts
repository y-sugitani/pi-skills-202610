/**
 * 対岸監督の lookup / 依頼 journal 枠 / spawn・intervene。
 * herdr I/O あり。triage は lib.ts。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { muxScript } from "../_shared/paths.ts";

function run(
	cmd: string,
	args: string[],
	opts?: { cwd?: string; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
			cwd: opts?.cwd,
		});
		let stdout = "";
		let stderr = "";
		let done = false;
		const finish = (code: number) => {
			if (done) return;
			done = true;
			resolve({ code, stdout, stderr });
		};
		const t = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			finish(124);
		}, opts?.timeoutMs ?? 30_000);
		child.stdout?.on("data", (b) => {
			stdout += String(b);
		});
		child.stderr?.on("data", (b) => {
			stderr += String(b);
		});
		child.on("error", () => {
			clearTimeout(t);
			finish(127);
		});
		child.on("close", (code) => {
			clearTimeout(t);
			finish(code ?? 1);
		});
	});
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function unwrap(data: unknown): unknown {
	const rec = asRecord(data);
	if (rec && "result" in rec) return rec.result;
	return data;
}

export type PeerLookup = {
	repo: string;
	tab_id: string;
	pane_id: string;
	agent: string;
	/** herdr wait / intervene の target。agent 名が pi のときは pane_id。 */
	target: string;
	status: string;
	cwd: string | null;
};

export async function lookupPeerSupervisor(repo: string): Promise<PeerLookup | null> {
	const label = repo.trim();
	if (!label) return null;
	const tabsRes = await run("herdr", ["tab", "list"], { timeoutMs: 15_000 });
	if (tabsRes.code !== 0) return null;
	const tabsRoot = asRecord(unwrap(parseJson(tabsRes.stdout)));
	const tabs = Array.isArray(tabsRoot?.tabs) ? tabsRoot.tabs : [];
	const tab = tabs
		.map((t) => asRecord(t))
		.find((t) => t && String(t.label ?? "") === label);
	if (!tab) return null;
	const tabId = String(tab.tab_id ?? "");
	if (!tabId) return null;

	const agentsRes = await run("herdr", ["agent", "list"], { timeoutMs: 15_000 });
	if (agentsRes.code !== 0) return null;
	const agentsRoot = asRecord(unwrap(parseJson(agentsRes.stdout)));
	const agents = Array.isArray(agentsRoot?.agents) ? agentsRoot.agents : [];
	const onTab = agents
		.map((a) => asRecord(a))
		.filter((a) => a && String(a.tab_id ?? "") === tabId);
	const pick =
		onTab.find((a) => a && String(a.agent_status ?? "") === "working") ??
		onTab.find((a) => a && String(a.agent_status ?? "") === "idle") ??
		onTab.find((a) => a && String(a.agent_status ?? "") === "blocked") ??
		onTab[0];
	if (!pick) return null;
	const agent = String(pick.agent ?? "pi");
	const paneId = String(pick.pane_id ?? "");
	const target = agent === "pi" && paneId ? paneId : agent;
	return {
		repo: label,
		tab_id: tabId,
		pane_id: paneId,
		agent,
		target,
		status: String(pick.agent_status ?? "unknown"),
		cwd: typeof pick.cwd === "string" ? pick.cwd : null,
	};
}

export function openRequestJournal(input: {
	path: string;
	label: string;
	what: string;
	where: string;
	done: string;
	progress?: string;
	requester?: string;
}): { ok: true; path: string; label: string } | { ok: false; error: string } {
	const path = input.path.trim();
	const label = input.label.trim();
	if (!path || !label) return { ok: false, error: "path_and_label_required" };
	if (existsSync(path)) return { ok: false, error: "exists" };
	const lines = [
		"---",
		"status: 進行中",
		"---",
		"",
		`# 依頼 ${label}`,
		"",
	];
	if (input.requester?.trim()) {
		lines.push("## 依頼元", "", `- ${input.requester.trim()}`, "");
	}
	if (input.progress?.trim()) {
		lines.push("## 対岸 progress", "", `- ${input.progress.trim()}`, "");
	}
	lines.push(
		"## 何を",
		"",
		input.what.trim() || "（未記入）",
		"",
		"## どこを",
		"",
		input.where.trim() || "（未記入）",
		"",
		"## どうなれば完了",
		"",
		input.done.trim() || "（未記入）",
		"",
		"## 記録",
		"",
	);
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, lines.join("\n"), "utf8");
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : "write_failed" };
	}
	return { ok: true, path, label };
}

export async function intervenePeer(target: string, message: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const interveneSh = muxScript("intervene.sh");
	if (!interveneSh) return { ok: false, stdout: "", stderr: "mux_scripts_missing" };
	const res = await run("bash", [interveneSh, "--agent", target, "--message", message], {
		timeoutMs: 40_000,
	});
	return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr };
}

export async function spawnPeerSupervisor(input: {
	workdir: string;
	repo: string;
	journal: string;
	label: string;
}): Promise<{ ok: boolean; agent?: string; tab_id?: string; pane_id?: string; error?: string; raw?: string }> {
	const spawnSh = muxScript("spawn-agent.sh");
	if (!spawnSh) return { ok: false, error: "mux_scripts_missing" };
	const task = `/tmp/lane-control/peer-start-${Date.now()}.md`;
	const body = [
		`このタブは ${input.repo} の司令塔。lane-control と wiki の依頼 journal に従え。`,
		`依頼 journal: ${input.journal}`,
		`依頼 marker（lane_watch label）: ${input.label}`,
		"自 repo の progress を読み、この依頼を着手待ちとしてレーン化する。",
		"依頼元リポのレーン化・main merge はするな。",
		"依頼が果たされたら依頼 journal を 検証完了（できないなら FAIL-<module> / 中止 / 延期）で閉じる。",
		"依頼 journal に merge待ち / merged は使うな（それは自レーン journal の語彙）。",
	].join("\n");
	try {
		mkdirSync("/tmp/lane-control", { recursive: true });
		writeFileSync(task, body, "utf8");
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : "task_write_failed" };
	}
	const res = await run(
		"bash",
		[spawnSh, "--task-file", task, "--workdir", input.workdir, "--title", input.repo, "--layout", "tab"],
		{ timeoutMs: 120_000 },
	);
	const parsed = asRecord(parseJson(res.stdout.trim().split("\n").filter(Boolean).pop() ?? res.stdout));
	if (res.code !== 0 || !parsed || parsed.ok === false) {
		return { ok: false, error: String((parsed?.error ?? res.stderr.slice(0, 200)) || "spawn_failed"), raw: res.stdout.slice(0, 400) };
	}
	return {
		ok: true,
		agent: typeof parsed.agent === "string" ? parsed.agent : undefined,
		tab_id: typeof parsed.tab_id === "string" ? parsed.tab_id : undefined,
		pane_id: typeof parsed.pane_id === "string" ? parsed.pane_id : undefined,
	};
}

export function peerInterveneMessage(journal: string, label: string): string {
	return [
		`依頼 journal を読んで着手せよ。path=${journal} marker=${label}。`,
		"この repo の監督として進め。依頼元リポはレーン化するな。",
		"果たしたら依頼 journal を 検証完了（または FAIL-<module> / 中止 / 延期）で閉じよ。merge待ちは使うな。",
	].join("");
}
