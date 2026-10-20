/**
 * session-timer — Pi セッション向けの wake タイマー。
 * timer_start / timer_stop / timer_status を登録し、時間になったら
 * 同じセッションへユーザーメッセージを打ち込む。壁時計の sleep 監視はしない。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_ROOT = "/tmp/session-timer";

type Timer = {
	id: string;
	intervalSec: number;
	message: string;
	/** 0 = unlimited。budget 系は 1 */
	maxTicks: number;
	timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null;
	tickCount: number;
	okCount: number;
	failCount: number;
	lastOkAt: string | null;
	lastError: string | null;
};

function appendLog(id: string, line: string) {
	try {
		mkdirSync(LOG_ROOT, { recursive: true });
		appendFileSync(join(LOG_ROOT, `${id}.log`), `${new Date().toISOString()} ${line}\n`);
	} catch {
		/* best-effort */
	}
}

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

export default function sessionTimer(pi: ExtensionAPI) {
	const timers = new Map<string, Timer>();

	function stop(id: string): boolean {
		const t = timers.get(id);
		if (!t) return false;
		if (t.timer) {
			clearTimeout(t.timer);
			clearInterval(t.timer);
		}
		t.timer = null;
		timers.delete(id);
		return true;
	}

	function stopAll() {
		for (const id of [...timers.keys()]) stop(id);
	}

	function fire(t: Timer) {
		t.tickCount += 1;
		const text = t.message.replaceAll("{id}", t.id).replaceAll("{n}", String(t.tickCount));
		const budgetish = t.id === "budget" || /TIME_BUDGET/i.test(t.message) || /即停止/i.test(t.message);
		const hitMax = t.maxTicks > 0 && t.tickCount >= t.maxTicks;
		if (hitMax) stop(t.id);

		try {
			// sendUserMessage は fire-and-forget。deliverAs 無しは処理中に tick が落ちる。
			pi.sendUserMessage(text, { deliverAs: budgetish ? "steer" : "followUp" });
			t.okCount += 1;
			t.lastOkAt = new Date().toISOString();
			t.lastError = null;
			appendLog(t.id, `ok n=${t.tickCount}`);
		} catch (e) {
			t.failCount += 1;
			t.lastError = errText(e);
			appendLog(t.id, `fail n=${t.tickCount} ${t.lastError}`);
		}
	}

	pi.on("session_shutdown", async () => {
		stopAll();
	});

	pi.registerTool({
		name: "timer_start",
		label: "Timer Start",
		description:
			"Start a wake timer for this session. Default is one-shot after interval_sec (budget). Set max_ticks=0 for periodic. Injects a tick message; does not inspect anything.",
		promptSnippet: "Wall-clock wake timer for this session (budget or periodic tick)",
		promptGuidelines: [
			"Use timer_start for wall-clock budgets and periodic checks. Do not sleep or poll a clock.",
			"id catalog: budget 1800 (child, first tool), cheap-main 300 max_ticks=0 (parent periodic), lane-main 180 (parent periodic).",
			"Do not start a child's budget timer on the parent session.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "timer id" }),
			interval_sec: Type.Optional(
				Type.Number({ description: "seconds until first tick / between ticks (default 180, min 5)" }),
			),
			message: Type.Optional(
				Type.String({
					description: 'tick text (default "TIMER_TICK: {id} n={n}"). Placeholders: {id} {n}',
				}),
			),
			max_ticks: Type.Optional(
				Type.Number({
					description:
						"max fires then auto-stop. Default 1 (one-shot). 0 = unlimited periodic. id=budget or TIME_BUDGET message forces 1.",
				}),
			),
		}),
		async execute(_toolCallId, args) {
			const id = args.id.trim();
			if (!id) {
				return { content: [{ type: "text", text: "ERROR: id required" }], details: { ok: false } };
			}
			if (timers.has(id)) stop(id);
			const intervalSec = Math.max(5, Math.floor(args.interval_sec ?? 180));
			const message = (args.message?.trim() || "TIMER_TICK: {id} n={n}").trim();
			const budgetish = id === "budget" || /TIME_BUDGET/i.test(message) || /即停止/i.test(message);
			let maxTicks =
				typeof args.max_ticks === "number" && Number.isFinite(args.max_ticks)
					? Math.floor(args.max_ticks)
					: 1;
			if (budgetish) maxTicks = 1;
			if (maxTicks < 0) maxTicks = 0;

			const t: Timer = {
				id,
				intervalSec,
				message,
				maxTicks,
				timer: null,
				tickCount: 0,
				okCount: 0,
				failCount: 0,
				lastOkAt: null,
				lastError: null,
			};
			if (maxTicks === 1) {
				t.timer = setTimeout(() => {
					fire(t);
				}, intervalSec * 1000);
			} else {
				t.timer = setInterval(() => {
					fire(t);
				}, intervalSec * 1000);
			}
			timers.set(id, t);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							ok: true,
							id,
							interval_sec: intervalSec,
							max_ticks: maxTicks,
							mode: maxTicks === 1 ? "one_shot" : maxTicks === 0 ? "periodic" : `max_${maxTicks}`,
							message,
						}),
					},
				],
				details: { ok: true, id, interval_sec: intervalSec, max_ticks: maxTicks },
			};
		},
	});

	pi.registerTool({
		name: "timer_stop",
		label: "Timer Stop",
		description: "Stop a session wake timer by id.",
		parameters: Type.Object({
			id: Type.String({ description: "timer id" }),
		}),
		async execute(_toolCallId, args) {
			const id = args.id.trim();
			return {
				content: [{ type: "text", text: JSON.stringify({ ok: stop(id), id }) }],
				details: { ok: timers.has(id) === false, id },
			};
		},
	});

	pi.registerTool({
		name: "timer_status",
		label: "Timer Status",
		description: "List session wake timers in this Pi process.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "optional timer id filter" })),
		}),
		async execute(_toolCallId, args) {
			const list = [...timers.values()]
				.filter((t) => !args.id || t.id === args.id)
				.map((t) => ({
					id: t.id,
					interval_sec: t.intervalSec,
					tick_count: t.tickCount,
					max_ticks: t.maxTicks,
					ok_count: t.okCount,
					fail_count: t.failCount,
					last_ok_at: t.lastOkAt,
					last_error: t.lastError,
					message: t.message,
				}));
			return {
				content: [{ type: "text", text: JSON.stringify({ ok: true, timers: list }) }],
				details: { ok: true, count: list.length },
			};
		},
	});
}
