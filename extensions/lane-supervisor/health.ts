/**
 * Mechanical + cheap-model health checks for lane-supervisor.
 * Parent model must not do these; only completion/anomaly escalate.
 */
import { spawn } from "node:child_process";
import {
	mkdirSync,
	readFileSync,
	existsSync,
	readdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveLaneCheapModel } from "../_shared/cheap-model-config.ts";
import {
	type HealthFacts,
	type JournalStatus,
	type LaneStatus,
	type WatchKind,
	buildCheapCheckPrompt,
	CHEAP_CHECK_SYSTEM,
	journalBodyMergePendingNear,
	journalWatchFacts,
	parseCheapVerdict,
} from "./lib.ts";

const LOG_ROOT = "/tmp/lane-control";
const LEASE_ROOT = join(LOG_ROOT, "leases");
const DEFAULT_LEASE_TTL_SEC = 120;
const CHEAP_TIMEOUT_MS = Number(process.env.LANE_CHEAP_TIMEOUT_MS || 90_000);

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
		}, opts?.timeoutMs ?? 15_000);
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

export async function collectHealthFacts(input: {
	status: LaneStatus;
	worktree?: string;
	branch?: string;
	journalPath?: string;
	journalMarker?: string;
	detail?: string;
}): Promise<HealthFacts> {
	let ahead: number | null = null;
	let dirty: boolean | null = null;
	let journalPresent: boolean | null = null;
	let journalStatus: JournalStatus | null = null;
	let journalMergePending: boolean | null = null;
	let journalStale: boolean | null = null;
	let statusWord: string | null = null;
	let journalNoMerge: boolean | null = null;
	let journalBodyMergePending: boolean | null = null;

	if (input.worktree && existsSync(input.worktree)) {
		const aheadRes = await run(
			"git",
			["-C", input.worktree, "rev-list", "--count", "main..HEAD"],
			{ timeoutMs: 10_000 },
		);
		if (aheadRes.code === 0) {
			const n = Number.parseInt(aheadRes.stdout.trim(), 10);
			ahead = Number.isFinite(n) ? n : null;
		} else {
			// main が無い worktree 等は origin/main を試す
			const ahead2 = await run(
				"git",
				["-C", input.worktree, "rev-list", "--count", "origin/main..HEAD"],
				{ timeoutMs: 10_000 },
			);
			if (ahead2.code === 0) {
				const n = Number.parseInt(ahead2.stdout.trim(), 10);
				ahead = Number.isFinite(n) ? n : null;
			}
		}
		const st = await run("git", ["-C", input.worktree, "status", "--porcelain"], { timeoutMs: 10_000 });
		if (st.code === 0) dirty = st.stdout.trim().length > 0;
	}

	if (input.journalPath && existsSync(input.journalPath)) {
		const marker = (input.journalMarker || "").trim();
		try {
			const body = readFileSync(input.journalPath, "utf8");
			const watch = journalWatchFacts(body, marker, {
				worktree: input.worktree,
				branch: input.branch,
			});
			journalPresent = watch.journalPresent;
			journalStatus = watch.journalStatus;
			journalMergePending = watch.journalMergePending;
			journalStale = watch.journalStale;
			statusWord = watch.statusWord;
			journalNoMerge = watch.journalNoMerge;
			if (watch.journalStatus === "missing" && marker) {
				journalBodyMergePending = journalBodyMergePendingNear(body, marker, input.branch);
			}
		} catch {
			journalPresent = null;
			journalStatus = "unknown";
			journalMergePending = null;
			journalStale = null;
			statusWord = null;
			journalNoMerge = null;
			journalBodyMergePending = null;
		}
	}
	return {
		status: input.status,
		ahead,
		dirty,
		journalPresent,
		journalStatus,
		journalMergePending,
		journalStale,
		statusWord,
		journalNoMerge,
		journalBodyMergePending,
		detail: input.detail,
	};
}

/**
 * P4/P5: レーン process（＝孫を lane_watch している側）が書く短い lease。
 * 司令塔 process は herdr agent list と OR で読み、どちらかが「孫 working」なら LANE_EVENT を出さない。
 * heartbeat（writer が working 中 30s 毎に updated_at を更新）と TTL で、クラッシュでも永久ピン止めしない。
 * 同一 tab 配下の cheap ごとに 1 ファイル。tab 無し cheap は書かない（herdr list フォールバック）。
 */

export type CheapLease = {
	tab: string;
	agent: string;
	status: string;
	updated_at: number;
	ttl_sec: number;
};

function leasePath(agent: string, root: string): string {
	const key = agent.replace(/[^A-Za-z0-9._-]/g, "_");
	return join(root, `${key}.json`);
}

export function writeCheapLease(
	input: { tabId?: string; agent: string; status: LaneStatus; ttlSec?: number },
	root = LEASE_ROOT,
): void {
	if (!input.tabId) return;
	try {
		mkdirSync(root, { recursive: true });
		const lease: CheapLease = {
			tab: input.tabId,
			agent: input.agent,
			status: input.status,
			updated_at: Date.now(),
			ttl_sec: input.ttlSec && input.ttlSec > 0 ? input.ttlSec : DEFAULT_LEASE_TTL_SEC,
		};
		writeFileSync(leasePath(input.agent, root), JSON.stringify(lease));
	} catch {
		/* best-effort */
	}
}

export function deleteCheapLease(agent: string, root = LEASE_ROOT): void {
	try {
		unlinkSync(leasePath(agent, root));
	} catch {
		/* best-effort */
	}
}

/** tab 配下に TTL 内の working lease があるか。TTL 切れ・非 working は busy にしない（fail-open）。 */
export function tabHasWorkingLease(
	tabId: string,
	opts?: { root?: string; now?: number },
): boolean {
	if (!tabId) return false;
	const root = opts?.root ?? LEASE_ROOT;
	const now = opts?.now ?? Date.now();
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return false;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const lease = JSON.parse(readFileSync(join(root, name), "utf8")) as CheapLease;
			if (lease.tab !== tabId || lease.status !== "working") continue;
			const ttl =
				typeof lease.ttl_sec === "number" && lease.ttl_sec > 0
					? lease.ttl_sec
					: DEFAULT_LEASE_TTL_SEC;
			if (now - lease.updated_at < ttl * 1000) return true;
		} catch {
			/* 壊れた lease は無視 */
		}
	}
	return false;
}

export type TabAgent = { name: string | null; status: string | null };

/**
 * P3: herdr agent list から tab_id 配下の agent 一覧を取る。
 * 失敗・非 JSON は null（fail-open: 呼び出し側で completion 抑止しない）。
 */
export async function listTabAgents(tabId: string): Promise<TabAgent[] | null> {
	if (!tabId) return null;
	const res = await run("herdr", ["agent", "list"], { timeoutMs: 10_000 });
	if (res.code !== 0) return null;
	try {
		const data = JSON.parse(res.stdout);
		const out: TabAgent[] = [];
		const walk = (d: unknown): void => {
			if (Array.isArray(d)) {
				for (const x of d) walk(x);
				return;
			}
			if (d && typeof d === "object") {
				const rec = d as Record<string, unknown>;
				if (typeof rec.tab_id === "string" && typeof rec.agent_status === "string" && rec.tab_id === tabId) {
					out.push({ name: typeof rec.name === "string" ? rec.name : null, status: rec.agent_status });
				}
				for (const v of Object.values(rec)) walk(v);
			}
		};
		walk(data);
		return out;
	} catch {
		return null;
	}
}

export function readSupervisorLogTail(maxChars = 2000): string {
	const path = join(LOG_ROOT, "supervisor.log");
	try {
		if (!existsSync(path)) return "";
		const body = readFileSync(path, "utf8");
		return body.length <= maxChars ? body : body.slice(body.length - maxChars);
	} catch {
		return "";
	}
}

/** Optional short agent surface for cheap review (not full transcript). */
export async function readAgentSurface(agent: string, lines = 40): Promise<string> {
	const res = await run("herdr", ["agent", "read", agent, "--lines", String(lines)], {
		timeoutMs: 12_000,
	});
	if (res.code !== 0) return "";
	return res.stdout.trim().slice(0, 2000);
}

/**
 * One-shot cheap model. No tools. Parent session is not involved.
 * Failure returns null (caller decides fallback).
 */
export async function runCheapHealthCheck(input: {
	kind: WatchKind;
	agent: string;
	reason: string;
	label?: string;
	facts: string[];
	logTail?: string;
	model?: string;
}): Promise<{ verdict: "ok" | "anomaly"; reason?: string; raw?: string } | null> {
	const model = input.model || resolveLaneCheapModel().model;
	const prompt = buildCheapCheckPrompt({
		kind: input.kind,
		agent: input.agent,
		reason: input.reason,
		label: input.label,
		facts: input.facts,
		logTail: input.logTail,
	});
	const args = [
		"-p",
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--thinking",
		"off",
		...(model ? ["--model", model] : []),
		"--system-prompt",
		CHEAP_CHECK_SYSTEM,
		prompt,
	];
	const res = await run("pi", args, { timeoutMs: CHEAP_TIMEOUT_MS });
	if (res.code !== 0 && !res.stdout.trim()) {
		return null;
	}
	const parsed = parseCheapVerdict(res.stdout || res.stderr);
	if (!parsed) return null;
	return { ...parsed, raw: res.stdout.slice(0, 400) };
}

export function cheapModelId(): string {
	return resolveLaneCheapModel().id;
}
