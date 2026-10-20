/**
 * lane-supervisor — Herdr レーン/安委譲/対岸監督の状態変化を拡張内で処理する。
 * 親（高コスト model）は signal=completion|anomaly のときだけ起こす。
 * lane の safety / 5 分点検の healthy は親に送らない（安い model がログ確認）。
 * cheap の拡張内 safety/periodic はオフ（親 cheap-main 300s が点検）。
 * peer（対岸監督）は依頼 journal 終端のときだけ親へ（PEER_EVENT）。拡張内 safety/periodic オフ。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	type LaneEventReason,
	type LaneStatus,
	type ParentSignal,
	type WatchKind,
	anyChildWorking,
	applyCheapVerdict,
	deferForGrandchildren,
	eventReason,
	extractAgentStatus,
	formatParentEvent,
	graceElapsedFollowup,
	peerNextForStatusWord,
	GRANDCHILD_SETTLE_DEBOUNCE_SEC,
	initialWatchEvent,
	JOURNAL_REREAD_SEC,
	STILL_SETTLED_GRACE_SEC,
	nextUntil,
	normalizeStatus,
	resolveWatchKind,
	shouldTriage,
	triageEvent,
	factsToStrings,
} from "./lib.ts";
import {
	cheapModelId,
	collectHealthFacts,
	deleteCheapLease,
	listTabAgents,
	readAgentSurface,
	readSupervisorLogTail,
	runCheapHealthCheck,
	tabHasWorkingLease,
	writeCheapLease,
} from "./health.ts";
import { isIntervening } from "./intervene-state.ts";
import {
	intervenePeer,
	lookupPeerSupervisor,
	openRequestJournal,
	peerInterveneMessage,
	spawnPeerSupervisor,
} from "./peer-ops.ts";

const LOG_ROOT = "/tmp/lane-control";
const WAIT_TIMEOUT_MS = 21_600_000; // 6h; safety timer covers "still working"
const DEFAULT_SAFETY_SEC = 900;
const DEFAULT_CHECK_INTERVAL_SEC = 300; // lane 5 min internal health (cheap は startWatch で 0)
const CUSTOM_TYPE = "lane-supervisor";
/** P4: defer 中の再確認間隔（check_interval 300s では待たない）。 */
const DEFER_RECHECK_SEC = 45;
/** P1: 孫 working 中の lease heartbeat / TTL。クラッシュで TTL 切れ → 永久ピン止めしない。 */
const LEASE_HEARTBEAT_SEC = 30;
const LEASE_TTL_SEC = 120;

type Watch = {
	agent: string;
	kind: WatchKind;
	tabId?: string;
	worktree?: string;
	branch?: string;
	label?: string;
	journalPath?: string;
	safetySec: number;
	checkIntervalSec: number;
	status: LaneStatus;
	child: ChildProcess | null;
	safetyTimer: ReturnType<typeof setTimeout> | null;
	checkTimer: ReturnType<typeof setInterval> | null;
	/** 孫（cheap explore/executor）稼働中に保留した settled。親を起こさず拡張内で待つ */
	deferredSettle: { from: LaneStatus; detail?: string } | null;
	deferredCheck: ReturnType<typeof setTimeout> | null;
	deferFailCount: number;
	/** P7: 孫 busy→idle のあと debounce 済みか。次 cheap を出す猶予。 */
	settleDebounced: boolean;
	/** 非終端 settled の 5 分様子見。armed 中は繰り返さない。 */
	stillSettledTimer: ReturnType<typeof setTimeout> | null;
	stillSettledArmedAt: number | null;
	stillSettledWoken: boolean;
	/** idle/done 中に journal を機械再読する間隔タイマー（lane / peer のみ）。 */
	journalRereadTimer: ReturnType<typeof setInterval> | null;
	lastEventAt: string | null;
	lastError: string | null;
	eventCount: number;
	parentWakeCount: number;
	lastSignal: ParentSignal | "healthy" | "waiting" | null;
	stopping: boolean;
	triageBusy: boolean;
};

type PersistOp =
	| {
			op: "watch";
			agent: string;
			kind: WatchKind;
			tabId?: string;
			worktree?: string;
			branch?: string;
			label?: string;
			journalPath?: string;
			safetySec: number;
			checkIntervalSec: number;
	  }
	| { op: "unwatch"; agent: string };

function appendLog(line: string) {
	try {
		mkdirSync(LOG_ROOT, { recursive: true });
		appendFileSync(join(LOG_ROOT, "supervisor.log"), `${new Date().toISOString()} ${line}\n`);
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

function herdrAvailable(): boolean {
	return process.env.HERDR_ENV === "1";
}

/** Herdr 外で lane_* / peer_supervisor を呼ばれたときの案内（Herdr 無し環境向け）。 */
const HERDR_REQUIRED = {
	ok: false,
	error: "herdr_required",
	hint: "lane_watch / lane_unwatch_status / peer_supervisor ensure は Herdr 専用（HERDR_ENV=1 が必要）。Herdr 外は subagent ツールを async: true で使い、完了通知で結果を受け取る。",
};

function parseAgentStatus(stdout: string): LaneStatus | null {
	try {
		const data = JSON.parse(stdout);
		const raw = extractAgentStatus(data);
		if (!raw) return null;
		return normalizeStatus(raw);
	} catch {
		return null;
	}
}

function getAgentStatus(agent: string): Promise<LaneStatus> {
	return new Promise((resolve) => {
		const child = spawn("herdr", ["agent", "get", agent], {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		let out = "";
		let err = "";
		child.stdout?.on("data", (b) => {
			out += String(b);
		});
		child.stderr?.on("data", (b) => {
			err += String(b);
		});
		child.on("error", () => resolve("gone"));
		child.on("close", (code) => {
			if (code !== 0) {
				appendLog(`get ${agent} exit=${code} ${err.trim().slice(0, 200)}`);
				resolve("gone");
				return;
			}
			resolve(parseAgentStatus(out) ?? "unknown");
		});
	});
}

export default function laneSupervisor(pi: ExtensionAPI) {
	const watches = new Map<string, Watch>();
	let restoring = false;

	function persist(op: PersistOp) {
		try {
			pi.appendEntry(CUSTOM_TYPE, op);
		} catch (e) {
			appendLog(`persist fail ${errText(e)}`);
		}
	}

	function clearSafety(w: Watch) {
		if (w.safetyTimer) {
			clearTimeout(w.safetyTimer);
			w.safetyTimer = null;
		}
	}

	function clearCheck(w: Watch) {
		if (w.checkTimer) {
			clearInterval(w.checkTimer);
			w.checkTimer = null;
		}
	}

	function clearDeferredCheck(w: Watch) {
		if (w.deferredCheck) {
			clearTimeout(w.deferredCheck);
			w.deferredCheck = null;
		}
	}

	function clearStillSettledGrace(w: Watch) {
		if (w.stillSettledTimer) {
			clearTimeout(w.stillSettledTimer);
			w.stillSettledTimer = null;
		}
	}

	/** 非終端 settled の 5 分様子見。既に armed / 親へ出したあとは重ねない。working で解除。 */
	function armStillSettledGrace(w: Watch) {
		if (w.stillSettledTimer || w.stillSettledWoken) return;
		w.stillSettledArmedAt = Date.now();
		w.stillSettledTimer = setTimeout(() => {
			w.stillSettledTimer = null;
			if (w.stopping || watches.get(w.agent) !== w) return;
			appendLog(`grace fire ${w.agent} ${STILL_SETTLED_GRACE_SEC}s`);
			void fire(w, w.status, w.status, "still_settled_grace", "grace_elapsed");
		}, STILL_SETTLED_GRACE_SEC * 1000);
		appendLog(`grace arm ${w.agent} ${STILL_SETTLED_GRACE_SEC}s`);
	}

	function clearJournalReread(w: Watch) {
		if (w.journalRereadTimer) {
			clearInterval(w.journalRereadTimer);
			w.journalRereadTimer = null;
		}
	}

	/** idle/done 中に journal を機械再読。終端なら completion。親トークン・安い model なし。 */
	function armJournalReread(w: Watch) {
		if ((w.kind !== "lane" && w.kind !== "peer") || !w.journalPath || w.journalRereadTimer || w.stillSettledWoken) return;
		w.journalRereadTimer = setInterval(() => {
			if (w.stopping || watches.get(w.agent) !== w) return;
			if (w.status !== "idle" && w.status !== "done") return;
			appendLog(`journal reread ${w.agent}`);
			void fire(w, w.status, w.status, "journal_reread", "journal_poll");
		}, JOURNAL_REREAD_SEC * 1000);
		appendLog(`journal reread arm ${w.agent} ${JOURNAL_REREAD_SEC}s`);
	}

	/** 同一 tab 配下に working な孫（lease / ローカル cheap watch / herdr agent list）が残っているか。null = 判定不能。 */
	async function grandchildrenBusy(w: Watch): Promise<boolean | null> {
		if (w.kind !== "lane" || !w.tabId) return false;
		// P1/P2: lease が正本（レーン process が自分の cheap watch 状態を書く）。TTL 内 working なら孫稼働中。
		if (tabHasWorkingLease(w.tabId)) return true;
		// ローカル cheap watch（同 process 内）。P5: working のみ抑止（gone 以外ではない）。
		const cheapWorking = [...watches.values()].some(
			(o) =>
				o !== w &&
				o.kind === "cheap" &&
				o.tabId &&
				w.tabId &&
				o.tabId === w.tabId &&
				o.status === "working",
		);
		if (cheapWorking) return true;
		const tabAgents = await listTabAgents(w.tabId);
		if (!tabAgents) return null;
		return anyChildWorking(tabAgents.filter((a) => a.name !== w.agent));
	}

	/** 保留した settled を今すぐ再評価する（待ちは呼び出し側）。 */
	async function runDeferredCheck(w: Watch) {
		if (w.stopping || watches.get(w.agent) !== w) return;
		if (!w.deferredSettle) return;
		// レーンが再稼働していれば保留を解消（次の settled で再評価される）
		if (w.status === "working" || w.status === "unknown") {
			w.deferredSettle = null;
			w.deferFailCount = 0;
			w.settleDebounced = false;
			w.stillSettledWoken = false;
			w.stillSettledArmedAt = null;
			clearStillSettledGrace(w);
			clearJournalReread(w);
			appendLog(`defer clear ${w.agent} (lane resumed working)`);
			return;
		}
		const busy = await grandchildrenBusy(w);
		if (w.stopping || watches.get(w.agent) !== w) return;
		if (!w.deferredSettle) return;
		if (busy === true) {
			w.settleDebounced = false;
			appendLog(`defer wait ${w.agent} (grandchildren still working)`);
			armDeferredCheck(w);
			return;
		}
		if (busy === null) {
			w.deferFailCount += 1;
			if (w.deferFailCount < 3) {
				appendLog(`defer retry ${w.agent} (agent list unavailable ${w.deferFailCount})`);
				armDeferredCheck(w);
				return;
			}
			appendLog(`defer fail-open ${w.agent} (agent list unavailable x${w.deferFailCount})`);
		}
		// P7: 孫完了直後は数秒待って次 cheap の猶予を残す（今日の 2 秒後 anomaly を親に見せない）。
		if (!w.settleDebounced) {
			w.settleDebounced = true;
			appendLog(`defer debounce ${w.agent} ${GRANDCHILD_SETTLE_DEBOUNCE_SEC}s`);
			clearDeferredCheck(w);
			w.deferredCheck = setTimeout(() => {
				w.deferredCheck = null;
				void runDeferredCheck(w);
			}, GRANDCHILD_SETTLE_DEBOUNCE_SEC * 1000);
			return;
		}
		w.deferFailCount = 0;
		w.settleDebounced = false;
		const d = w.deferredSettle;
		w.deferredSettle = null;
		appendLog(`defer fire ${w.agent} (grandchildren settled) — re-triage`);
		void fire(w, d.from, w.status, "deferred_settled", d.detail);
	}

	/** 保留した settled を孫の終了まで extension 内で待つ（親には何も送らない）。 */
	function armDeferredCheck(w: Watch) {
		clearDeferredCheck(w);
		if (!w.deferredSettle) return;
		// P4: defer 中の再確認は 30–60s 程度（check_interval 300s のまま待たない）。
		w.deferredCheck = setTimeout(() => {
			w.deferredCheck = null;
			void runDeferredCheck(w);
		}, DEFER_RECHECK_SEC * 1000);
	}

	function killChild(w: Watch) {
		if (!w.child) return;
		const child = w.child;
		w.child = null;
		try {
			child.kill("SIGTERM");
		} catch {
			/* ignore */
		}
	}

	let leaseHeartbeat: ReturnType<typeof setInterval> | null = null;

	/** P1: ローカル cheap watch の状態を lease に反映（working → write / 他 → delete）。heartbeat は working 中のみ。 */
	function syncCheapLeases() {
		let anyWorking = false;
		for (const o of watches.values()) {
			if (o.kind !== "cheap") continue;
			if (o.status === "working") {
				anyWorking = true;
				writeCheapLease({ tabId: o.tabId, agent: o.agent, status: o.status, ttlSec: LEASE_TTL_SEC });
			} else {
				deleteCheapLease(o.agent);
			}
		}
		if (anyWorking) {
			if (!leaseHeartbeat) {
				leaseHeartbeat = setInterval(() => syncCheapLeases(), LEASE_HEARTBEAT_SEC * 1000);
			}
		} else if (leaseHeartbeat) {
			clearInterval(leaseHeartbeat);
			leaseHeartbeat = null;
		}
	}

	function armSafety(w: Watch) {
		clearSafety(w);
		if (w.safetySec <= 0) return;
		if (w.status !== "working" && w.status !== "unknown") return;
		w.safetyTimer = setTimeout(() => {
			w.safetyTimer = null;
			if (w.stopping) return;
			void fire(w, w.status, w.status, "safety", "still_working");
			armSafety(w);
		}, w.safetySec * 1000);
	}

	function armCheck(w: Watch) {
		clearCheck(w);
		if (w.checkIntervalSec <= 0) return;
		w.checkTimer = setInterval(() => {
			if (w.stopping || watches.get(w.agent) !== w) return;
			if (w.status !== "working" && w.status !== "unknown") return;
			void fire(w, w.status, w.status, "periodic", "interval_check");
		}, w.checkIntervalSec * 1000);
	}

	async function fire(w: Watch, from: LaneStatus, to: LaneStatus, reason: LaneEventReason, detail?: string) {
		if (w.stopping || watches.get(w.agent) !== w) {
			appendLog(`drop ${w.agent} ${from}->${to} ${reason} (unwatched)`);
			return;
		}
		if (!shouldTriage(from, to, reason)) {
			appendLog(`skip ${w.agent} ${from}->${to} ${reason} (no triage)`);
			return;
		}
		if (w.triageBusy) {
			appendLog(`coalesce ${w.agent} ${reason} (busy)`);
			return;
		}
		w.triageBusy = true;
		try {
			w.eventCount += 1;
			const statusNow =
				reason === "periodic" ||
				reason === "safety" ||
				reason === "deferred_settled" ||
				reason === "still_settled_grace" ||
				reason === "journal_reread"
					? await getAgentStatus(w.agent)
					: to;
			if (w.stopping || watches.get(w.agent) !== w) return;
			if (statusNow === "gone" && reason !== "gone") {
				w.status = "gone";
				clearSafety(w);
				clearCheck(w);
			}
			syncCheapLeases();
			const effectiveTo = statusNow;
			const health = await collectHealthFacts({
				status: effectiveTo,
				worktree: w.worktree,
				branch: w.branch,
				journalPath: w.journalPath,
				journalMarker: w.label,
				detail,
			});
			let triage = triageEvent({
				kind: w.kind,
				reason,
				to: effectiveTo,
				health,
			});

			// P3/P5: 孫（cheap explore/executor）が working の間、lane settled の completion / anomaly / waiting も deferred。
			// lease（レーン process が書く）と herdr agent list を OR。どちらかが「孫 working」なら親へ出さない
			// （cheap review も回さない）。孫終了後に 1 回だけ再トリアージ（armDeferredCheck）。
			if (
				w.kind === "lane" &&
				(triage.signal === "completion" || triage.signal === "anomaly" || triage.signal === "waiting") &&
				(reason === "settled" || effectiveTo === "idle" || effectiveTo === "done") &&
				w.tabId
			) {
				const grandchildren = await grandchildrenBusy(w);
				if (w.stopping || watches.get(w.agent) !== w) return;
				if (grandchildren === true) {
					triage = deferForGrandchildren(triage, true);
					appendLog(
						`defer ${w.agent} ${from}->${effectiveTo} ${reason} signal=${triage.signal} verdict=${triage.verdict}（孫 working — lease/herdr）`,
					);
				}
			}

			if (triage.needsCheapReview && reason !== "journal_reread" && reason !== "still_settled_grace") {
				const surface = await readAgentSurface(w.agent, 30);
				const logTail = [readSupervisorLogTail(1200), surface].filter(Boolean).join("\n---\n");
				const cheap = await runCheapHealthCheck({
					kind: w.kind,
					agent: w.agent,
					reason,
					label: w.label,
					facts: factsToStrings(health),
					logTail,
				});
				if (cheap) {
					triage = applyCheapVerdict(triage, cheap);
					appendLog(
						`cheap ${w.agent} ${reason} -> ${cheap.verdict} ${cheap.reason ?? ""}`.slice(0, 240),
					);
				} else {
					// cheap 失敗: settled 不明は anomaly で親へ。safety/periodic は healthy 扱い（親を起こさない）
					if (reason === "settled") {
						triage = {
							signal: "anomaly",
							verdict: "needs_review",
							needsCheapReview: false,
							facts: factsToStrings(health),
							summary: "cheap check failed — parent review",
						};
					} else {
						triage = {
							signal: "healthy",
							verdict: "healthy",
							needsCheapReview: false,
							facts: factsToStrings(health),
							summary: "cheap check failed — assume healthy",
						};
					}
					appendLog(`cheap fail ${w.agent} ${reason}`);
				}
			}

			// 孫（cheap explore/executor）が working の間、親へ LANE_EVENT を出さない（anomaly にもしない）。
			// extension 内で待つ: herdr wait は継続、armDeferredCheck が孫の終了を確認して settled を再トリアージする。
			if (triage.signal === "deferred") {
				clearStillSettledGrace(w);
				clearJournalReread(w);
				w.deferredSettle = { from, detail };
				appendLog(`defer ${w.agent} ${from}->${effectiveTo} ${reason} — 孫 working 中は親を起こさない`);
				armDeferredCheck(w);
				return;
			}

			// 介入中（mux_intervene force=true の execute 中）の cheap settled は親へ出さない。
			// esc 由来の一時 idle（すぐ working に戻る）で completion を飛ばさない。
			// 介入終了後は mux_intervene 側が herdr agent get で拾う（idle/done のときだけ completion）。
			if (w.kind === "cheap" && isIntervening(w.agent)) {
				w.lastEventAt = new Date().toISOString();
				appendLog(`intervening suppress ${w.agent} ${from}->${effectiveTo} ${reason}`);
				return;
			}

			// 非終端 idle/done: すぐ親へ出さない。nudge しない。5 分後にまだ止まっていたら 1 回 anomaly。
			// peer（対岸監督）は依頼 journal 終端まで journal 再読だけで待つ（grace anomaly しない・完了条件）。
			if (triage.signal === "waiting") {
				w.lastEventAt = new Date().toISOString();
				if (w.kind === "peer") {
					w.lastSignal = "waiting";
					appendLog(
						`peer waiting ${w.agent} ${from}->${effectiveTo} ${reason} verdict=${triage.verdict} — journal 再読のみ・grace anomaly しない`,
					);
					armJournalReread(w);
					return;
				}
				if (reason === "still_settled_grace") {
					const afterGrace = graceElapsedFollowup(w.kind, triage);
					if (afterGrace === null) {
						w.lastSignal = "waiting";
						appendLog(`peer grace skip ${w.agent} (anomaly しない)`);
						armJournalReread(w);
						return;
					}
					if (w.stillSettledWoken) {
						w.lastSignal = "waiting";
						appendLog(`grace skip ${w.agent} (already woken)`);
						return;
					}
					w.stillSettledWoken = true;
					clearStillSettledGrace(w);
					clearJournalReread(w);
					triage = afterGrace;
				} else {
					w.lastSignal = "waiting";
					armStillSettledGrace(w);
					armJournalReread(w);
					appendLog(
						`triage ${w.agent} ${from}->${effectiveTo} ${reason} signal=waiting verdict=${triage.verdict}`,
					);
					return;
				}
			}

			w.lastEventAt = new Date().toISOString();
			appendLog(
				`triage ${w.agent} ${from}->${effectiveTo} ${reason} signal=${triage.signal} verdict=${triage.verdict}`,
			);

			if (triage.signal !== "completion" && triage.signal !== "anomaly") {
				w.lastSignal = "healthy";
				return;
			}
			w.lastSignal = triage.signal;
			clearStillSettledGrace(w);
			clearJournalReread(w);

			const peerNext =
				w.kind === "peer" && triage.signal === "completion"
					? peerNextForStatusWord(health.statusWord)
					: undefined;
			const text = formatParentEvent({
				kind: w.kind,
				signal: triage.signal,
				agent: w.agent,
				from,
				to: effectiveTo,
				reason,
				verdict: triage.verdict,
				label: w.label,
				tabId: w.tabId,
				worktree: w.worktree,
				branch: w.branch,
				facts: triage.facts,
				summary: triage.summary,
				detail,
				next: peerNext,
			});
			try {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
				w.parentWakeCount += 1;
				w.lastError = null;
				appendLog(`wake ${w.agent} signal=${triage.signal} ${reason}`);
				// 依頼は終わった。対岸タブは残し、同じ終端で PEER_EVENT を再送しない。
				if (w.kind === "peer" && triage.signal === "completion") {
					const agent = w.agent;
					stopWatch(agent);
					if (!restoring) persist({ op: "unwatch", agent });
					appendLog(`peer auto-unwatch ${agent}`);
				}
			} catch (e) {
				w.lastError = errText(e);
				appendLog(`send fail ${w.agent} ${w.lastError}`);
			}
		} finally {
			w.triageBusy = false;
		}
	}

	function armWait(w: Watch) {
		if (w.stopping) return;
		killChild(w);
		const until = nextUntil(w.status);
		if (until.length === 0) return;

		const args = ["agent", "wait", w.agent];
		for (const st of until) {
			args.push("--until", st);
		}
		args.push("--timeout", String(WAIT_TIMEOUT_MS));

		const child = spawn("herdr", args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		w.child = child;
		let err = "";
		child.stderr?.on("data", (b) => {
			err += String(b);
		});
		child.on("error", (e) => {
			if (w.stopping || w.child !== child) return;
			w.child = null;
			w.lastError = errText(e);
			appendLog(`wait spawn fail ${w.agent} ${w.lastError}`);
			setTimeout(() => {
				if (!w.stopping && watches.get(w.agent) === w) void onWaitDone(w, 1, w.lastError ?? "spawn_error");
			}, 2000);
		});
		child.on("close", (code) => {
			if (w.stopping || w.child !== child) return;
			w.child = null;
			void onWaitDone(w, code ?? 1, err.trim());
		});
	}

	async function onWaitDone(w: Watch, code: number, err: string) {
		if (w.stopping || watches.get(w.agent) !== w) return;
		const next = await getAgentStatus(w.agent);
		if (w.stopping || watches.get(w.agent) !== w) return;
		const from = w.status;
		if (next === "gone") {
			w.status = "gone";
			clearSafety(w);
			clearCheck(w);
			syncCheapLeases();
			void fire(w, from, "gone", "gone", err || `wait_exit_${code}`);
			return;
		}
		if (code !== 0 && next === from) {
			w.lastError = err || `wait_exit_${code}`;
			// timeout while still working: safety path (triage may keep parent asleep)
			if (from === "working" || from === "unknown") {
				void fire(w, from, next, "safety", `wait_timeout_or_error:${w.lastError.slice(0, 80)}`);
			} else {
				void fire(w, from, next, "wait_error", w.lastError.slice(0, 80));
			}
			setTimeout(() => {
				if (!w.stopping && watches.get(w.agent) === w) armWait(w);
			}, 1500);
			return;
		}
		w.status = next;
		syncCheapLeases();
		if (next === "working" || next === "unknown") {
			armSafety(w);
			w.deferredSettle = null;
			w.deferFailCount = 0;
			w.settleDebounced = false;
			w.stillSettledWoken = false;
			w.stillSettledArmedAt = null;
			clearDeferredCheck(w);
			clearStillSettledGrace(w);
			clearJournalReread(w);
		} else {
			clearSafety(w);
		}
		void fire(w, from, next, eventReason(from, next));
		if (from === next) {
			setTimeout(() => {
				if (!w.stopping && watches.get(w.agent) === w) armWait(w);
			}, 1500);
			return;
		}
		armWait(w);
	}

	async function startWatch(input: {
		agent: string;
		kind: WatchKind;
		tabId?: string;
		worktree?: string;
		branch?: string;
		label?: string;
		journalPath?: string;
		safetySec: number;
		checkIntervalSec: number;
	}): Promise<Watch> {
		// 親 300s timer が cheap の点検正本。拡張内 safety/periodic は二重になる。
		// peer（対岸監督）も点検しない（依頼 journal 終端だけ親へ。対岸側の監督が持つ）。
		const safetySec = input.kind === "cheap" || input.kind === "peer" ? 0 : input.safetySec;
		const checkIntervalSec = input.kind === "cheap" || input.kind === "peer" ? 0 : input.checkIntervalSec;
		const existing = watches.get(input.agent);
		if (existing) {
			existing.stopping = true;
			killChild(existing);
			clearSafety(existing);
			clearCheck(existing);
			clearDeferredCheck(existing);
			clearStillSettledGrace(existing);
			clearJournalReread(existing);
			existing.deferredSettle = null;
			watches.delete(input.agent);
		}
		const status = await getAgentStatus(input.agent);
		const w: Watch = {
			agent: input.agent,
			kind: input.kind,
			tabId: input.tabId,
			worktree: input.worktree,
			branch: input.branch,
			label: input.label,
			journalPath: input.journalPath,
			safetySec,
			checkIntervalSec,
			status,
			child: null,
			safetyTimer: null,
			checkTimer: null,
			deferredSettle: null,
			deferredCheck: null,
			deferFailCount: 0,
			settleDebounced: false,
			stillSettledTimer: null,
			stillSettledArmedAt: null,
			stillSettledWoken: false,
			journalRereadTimer: null,
			lastEventAt: null,
			lastError: status === "gone" ? "agent_not_found" : null,
			eventCount: 0,
			parentWakeCount: 0,
			lastSignal: null,
			stopping: false,
			triageBusy: false,
		};
		watches.set(input.agent, w);
		syncCheapLeases();
		if (status === "gone") {
			appendLog(`watch ${input.agent} gone at start`);
			return w;
		}
		const initial = initialWatchEvent(status);
		if (initial) {
			void fire(w, initial.from, status, initial.reason, initial.detail);
		} else {
			armSafety(w);
		}
		armCheck(w);
		armWait(w);
		appendLog(
			`watch ${input.agent} kind=${input.kind} status=${status} safety=${safetySec} check=${checkIntervalSec} cheap=${cheapModelId()}`,
		);
		return w;
	}

	function stopWatch(agent: string): boolean {
		const w = watches.get(agent);
		if (!w) return false;
		w.stopping = true;
		killChild(w);
		clearSafety(w);
		clearCheck(w);
		clearDeferredCheck(w);
		clearStillSettledGrace(w);
		clearJournalReread(w);
		w.deferredSettle = null;
		watches.delete(agent);
		// P1: unwatch で lease を解放（レーン process クラッシュ時は TTL で自然失効）。
		if (w.kind === "cheap") {
			deleteCheapLease(w.agent);
			syncCheapLeases();
		}
		appendLog(`unwatch ${agent}`);
		return true;
	}

	function stopAll() {
		for (const agent of [...watches.keys()]) stopWatch(agent);
	}

	function snapshot(agent?: string) {
		return [...watches.values()]
			.filter((w) => !agent || w.agent === agent)
			.map((w) => ({
				agent: w.agent,
				kind: w.kind,
				status: w.status,
				tab_id: w.tabId ?? null,
				worktree: w.worktree ?? null,
				branch: w.branch ?? null,
				label: w.label ?? null,
				journal: w.journalPath ?? null,
				safety_sec: w.safetySec,
				check_interval_sec: w.checkIntervalSec,
				waiting: w.child != null,
				event_count: w.eventCount,
				parent_wake_count: w.parentWakeCount,
				last_signal: w.lastSignal,
				deferred: w.deferredSettle != null,
				grace_armed: w.stillSettledTimer != null,
				grace_woken: w.stillSettledWoken,
				journal_reread: w.journalRereadTimer != null,
				last_event_at: w.lastEventAt,
				last_error: w.lastError,
			}));
	}

	pi.on("session_shutdown", async () => {
		stopAll();
	});

	// P1: この process（レーン側）が settle したとき、ローカル cheap が working なら lease を書き直す。
	// 司令塔が herdr wait から settled を見て lease を読む瞬間に、lease が fresh であることを保証する。
	pi.on("agent_settled", async () => {
		syncCheapLeases();
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!herdrAvailable()) return;
		restoring = true;
		try {
			const latest = new Map<string, PersistOp>();
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
				const data = entry.data as PersistOp | undefined;
				if (!data || typeof data !== "object" || !("op" in data) || !data.agent) continue;
				latest.set(data.agent, data);
			}
			for (const op of latest.values()) {
				if (op.op === "watch") {
					const w = await startWatch({
						agent: op.agent,
						kind: resolveWatchKind({ kind: op.kind, label: op.label }),
						tabId: op.tabId,
						worktree: op.worktree,
						branch: op.branch,
						label: op.label,
						journalPath: op.journalPath,
						safetySec: op.safetySec,
						checkIntervalSec:
							typeof op.checkIntervalSec === "number" ? op.checkIntervalSec : DEFAULT_CHECK_INTERVAL_SEC,
					});
					if (w.status === "gone") stopWatch(w.agent);
				}
			}
		} catch (e) {
			appendLog(`restore fail ${errText(e)}`);
		} finally {
			restoring = false;
		}
	});

	pi.registerTool({
		name: "lane_watch",
		label: "Lane Watch",
		description:
			"Watch a Herdr agent. Extension triages events; parent only receives CHEAP_EVENT/LANE_EVENT/PEER_EVENT with signal=completion|anomaly. Lane healthy safety/5min checks stay in-extension (cheap model). Cheap/peer in-extension safety/periodic are off. peer: 依頼 journal 終端のときだけ親へ。",
		promptSnippet:
			"Event-driven supervisor with in-extension triage. Parent wakes only on completion/anomaly; 孫 working 中は lane settled でも deferred。kind=lane の非終端 idle/done は 5 分様子見のあと 1 anomaly。nudge しない。cheap の拡張内 safety/periodic はオフ。kind=peer は依頼 journal 終端のときだけ親を起こす（PEER_EVENT）。定期点検オフ。対岸タブは閉じない・merge/撤収しない。",
		promptGuidelines: [
			"After mux-pi spawn-agent (lane tab or cheap pane), call lane_watch with kind=cheap|lane and the returned agent.",
			"Cheap: kind=cheap, label=cheap-*. 拡張内 safety/periodic はオフ。Lanes: kind=lane, safety_sec 900. check_interval_sec default 300 (in-extension).",
			"Optional journal path + label enables premature-settled detection without waking parent for healthy ticks (見出しは先に Lane <label> / 見出し先頭の feat/<branch>、落ちたら部分一致で拾う).",
			"孫が working の間、レーン settled でも LANE_EVENT は来ない（completion も anomaly も defer。レーン process が /tmp/lane-control/leases に書く lease と herdr list の OR で判定）。親は待つだけでよい。",
			"kind=lane の通告は journal 終端（frontmatter status 先）。idle 中も拡張が journal を再読（親トークンなし）。非終端のまま 5 分で anomaly 1 回。nudge しない。",
			"Parent must only act on signal=completion|anomaly. Never deep-read transcripts on routine events. Healthy events are not delivered.",
			"On CHEAP_EVENT completion: 閉じる判定のあと、枠を閉じる前に review を read（delegate-execute レビュー節）。未実施のまま完了を言うな。そのあと lane_unwatch → mux_close。",
			"On LANE_EVENT: signal=completion|anomaly。閉じる枠操作は lane_unwatch → mux_close。",
			"On PEER_EVENT (kind=peer): next=resume_verify|deny_no_workaround|stop|inspect_journal を見て動け。対岸タブは閉じるな。completion の peer watch は extension が外す。対岸レーンを lane_watch するな。",
			"On signal=anomaly: short intervene or policy only. Do not escalate to jsonl deep-read by default.",
			"ネストした explore/executor を lane_watch するな。監督はレーン内で行う。",
			"If event agent is not in current watches, ignore. Do not status/git/rewatch/restart.",
			"Teardown: lane_unwatch first. Do not prompt the dying lane. Then close.",
			"Do not call herdr agent wait or sleep to monitor.",
		],
		parameters: Type.Object({
			agent: Type.String({ description: "herdr agent name from spawn-agent.json" }),
			kind: Type.Optional(
				Type.String({
					description: "cheap | lane | peer. Emits CHEAP_EVENT, LANE_EVENT, or PEER_EVENT. Default: label cheap* → cheap, label peer* → peer, else lane",
				}),
			),
			tab_id: Type.Optional(Type.String({ description: "herdr tab id" })),
			worktree: Type.Optional(Type.String({ description: "lane worktree path" })),
			branch: Type.Optional(Type.String({ description: "lane branch" })),
			label: Type.Optional(Type.String({ description: "cheap-<title> or lane id (also journal marker)" })),
			journal: Type.Optional(
				Type.String({
					description:
						"journal file path for premature-settled detection (見出しは label または feat/<branch> の部分一致で拾う)。peer は依頼 journal パス（label=依頼 marker）",
				}),
			),
			safety_sec: Type.Optional(
				Type.Number({
					description: "in-extension still-working check (default 900 lane). cheap は無視して 0。0=off, min 60 when >0. Does not wake parent if healthy.",
				}),
			),
			check_interval_sec: Type.Optional(
				Type.Number({
					description: "in-extension periodic health (default 300 lane). cheap は無視して 0。Uses cheap model. 0=off. Healthy → no parent wake.",
				}),
			),
		}),
		async execute(_toolCallId, args) {
			if (!herdrAvailable()) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(HERDR_REQUIRED),
						},
					],
					details: { ok: false, error: "herdr_required" },
				};
			}
			const agent = args.agent.trim();
			if (!agent) {
				return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "agent_required" }) }] };
			}
			let safetySec =
				typeof args.safety_sec === "number" && Number.isFinite(args.safety_sec)
					? Math.floor(args.safety_sec)
					: DEFAULT_SAFETY_SEC;
			if (safetySec < 0) safetySec = 0;
			if (safetySec > 0 && safetySec < 60) safetySec = 60;

			let checkIntervalSec =
				typeof args.check_interval_sec === "number" && Number.isFinite(args.check_interval_sec)
					? Math.floor(args.check_interval_sec)
					: DEFAULT_CHECK_INTERVAL_SEC;
			if (checkIntervalSec < 0) checkIntervalSec = 0;
			if (checkIntervalSec > 0 && checkIntervalSec < 60) checkIntervalSec = 60;

			const label = args.label?.trim() || undefined;
			const kind = resolveWatchKind({ kind: args.kind, label });
			const w = await startWatch({
				agent,
				kind,
				tabId: args.tab_id?.trim() || undefined,
				worktree: args.worktree?.trim() || undefined,
				branch: args.branch?.trim() || undefined,
				label,
				journalPath: args.journal?.trim() || undefined,
				safetySec,
				checkIntervalSec,
			});
			if (!restoring) {
				persist({
					op: "watch",
					agent: w.agent,
					kind: w.kind,
					tabId: w.tabId,
					worktree: w.worktree,
					branch: w.branch,
					label: w.label,
					journalPath: w.journalPath,
					safetySec: w.safetySec,
					checkIntervalSec: w.checkIntervalSec,
				});
			}
			const eventName = w.kind === "cheap" ? "CHEAP_EVENT" : w.kind === "peer" ? "PEER_EVENT" : "LANE_EVENT";
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							ok: true,
							agent: w.agent,
							kind: w.kind,
							status: w.status,
							tab_id: w.tabId ?? null,
							worktree: w.worktree ?? null,
							journal: w.journalPath ?? null,
							safety_sec: w.safetySec,
							check_interval_sec: w.checkIntervalSec,
							cheap_model: cheapModelId(),
							watching: w.status !== "gone",
							hint:
								w.status === "gone"
									? "agent が見つからない。spawn-agent の name を確認"
									: w.kind === "cheap"
										? `${eventName} は signal=completion|anomaly のときだけ親へ。拡張内 safety/periodic はオフ。親は timer_start cheap-main 300s。介入は mux_intervene force=true（中断挿入）。`
										: w.kind === "peer"
											? `${eventName} は依頼 journal 終端（signal=completion）のときだけ親へ。定期点検・対岸レーン監視はしない。対岸の枠・成果は対岸監督側が扱う（この側から merge/撤収・タブ操作しない）。`
											: `${eventName} は signal=completion|anomaly のときだけ親へ。5分/safety の healthy は extension+${cheapModelId()} 内で処理。timer_start lane-check 不要。`,
						}),
					},
				],
				details: { ok: true, agent: w.agent, kind: w.kind, status: w.status },
			};
		},
	});

	pi.registerTool({
		name: "peer_supervisor",
		label: "Peer Supervisor",
		description:
			"対岸監督の lookup / 依頼 journal 枠作成 / 既存へ intervene または spawn。対岸レーンは作らない。ensure は kind=peer で watch までやる。",
		promptSnippet: "対岸は peer_supervisor。自レーン化禁止。lookup → 既存 intervene / 無ければ spawn。open_journal は枠だけ。",
		promptGuidelines: [
			"FAIL-<module> のあと対岸レーンを lane_watch するな。peer_supervisor ensure か lookup。",
			"open_journal は frontmatter 進行中と見出し 依頼 <label> を固定。progress 1 行は wiki で AI が書く。",
			"tab ラベルは repo 名と一致。既存監督は奪わず intervene。",
		],
		parameters: Type.Object({
			action: Type.String({ description: "lookup | ensure | open_journal" }),
			repo: Type.Optional(Type.String({ description: "対岸 repo 名（tab ラベル）。lookup/ensure 必須" })),
			workdir: Type.Optional(Type.String({ description: "対岸 main の絶対パス。ensure で spawn するとき必須" })),
			journal: Type.Optional(Type.String({ description: "依頼 journal の絶対パス。ensure / open_journal" })),
			label: Type.Optional(Type.String({ description: "依頼 marker。lane_watch label と一致" })),
			what: Type.Optional(Type.String({ description: "open_journal: 何を" })),
			where: Type.Optional(Type.String({ description: "open_journal: どこを" })),
			done: Type.Optional(Type.String({ description: "open_journal: どうなれば完了" })),
			progress: Type.Optional(Type.String({ description: "open_journal: 対岸 progress パス" })),
			requester: Type.Optional(Type.String({ description: "open_journal: 依頼元" })),
		}),
		async execute(_toolCallId, args) {
			const action = (args.action ?? "").trim();
			if (action === "lookup") {
				const repo = (args.repo ?? "").trim();
				if (!repo) {
					return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "repo_required" }) }] };
				}
				const found = await lookupPeerSupervisor(repo);
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: true, found: found !== null, supervisor: found }) }],
				};
			}
			if (action === "open_journal") {
				const r = openRequestJournal({
					path: args.journal ?? "",
					label: args.label ?? "",
					what: args.what ?? "",
					where: args.where ?? "",
					done: args.done ?? "",
					progress: args.progress,
					requester: args.requester,
				});
				return { content: [{ type: "text", text: JSON.stringify(r) }] };
			}
			if (action === "ensure") {
				if (!herdrAvailable()) {
					return { content: [{ type: "text", text: JSON.stringify(HERDR_REQUIRED) }] };
				}
				const repo = (args.repo ?? "").trim();
				const journal = (args.journal ?? "").trim();
				const label = (args.label ?? "").trim();
				if (!repo || !journal || !label) {
					return {
						content: [{ type: "text", text: JSON.stringify({ ok: false, error: "repo_journal_label_required" }) }],
					};
				}
				const found = await lookupPeerSupervisor(repo);
				let target = found?.target;
				let tabId = found?.tab_id;
				let spawned = false;
				if (found) {
					const iv = await intervenePeer(found.target, peerInterveneMessage(journal, label));
					if (!iv.ok) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({ ok: false, error: "intervene_failed", stderr: iv.stderr.slice(0, 300) }),
								},
							],
						};
					}
				} else {
					const workdir = (args.workdir ?? "").trim();
					if (!workdir) {
						return {
							content: [{ type: "text", text: JSON.stringify({ ok: false, error: "workdir_required_to_spawn" }) }],
						};
					}
					const sp = await spawnPeerSupervisor({ workdir, repo, journal, label });
					if (!sp.ok || !sp.agent) {
						return {
							content: [{ type: "text", text: JSON.stringify({ ok: false, error: sp.error ?? "spawn_failed" }) }],
						};
					}
					target = sp.agent;
					tabId = sp.tab_id;
					spawned = true;
				}
				if (!target) {
					return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "no_target" }) }] };
				}
				const w = await startWatch({
					agent: target,
					kind: "peer",
					tabId,
					label,
					journalPath: journal,
					safetySec: 0,
					checkIntervalSec: 0,
				});
				if (!restoring) {
					persist({
						op: "watch",
						agent: w.agent,
						kind: "peer",
						tabId: w.tabId,
						label: w.label,
						journalPath: w.journalPath,
						safetySec: 0,
						checkIntervalSec: 0,
					});
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								ok: true,
								action: "ensure",
								spawned,
								existing: !spawned,
								agent: w.agent,
								tab_id: w.tabId ?? null,
								kind: "peer",
								journal,
								label,
								watching: w.status !== "gone",
							}),
						},
					],
				};
			}
			return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "bad_action" }) }] };
		},
	});

	pi.registerTool({
		name: "lane_unwatch",
		label: "Lane Unwatch",
		description: "Stop watching a Herdr lane agent. Call before closing the lane tab.",
		parameters: Type.Object({
			agent: Type.String({ description: "herdr agent name" }),
		}),
		async execute(_toolCallId, args) {
			const agent = args.agent.trim();
			const existed = stopWatch(agent);
			if (existed) persist({ op: "unwatch", agent });
			return {
				content: [{ type: "text", text: JSON.stringify({ ok: true, agent, existed }) }],
				details: { ok: true, existed },
			};
		},
	});

	pi.registerTool({
		name: "lane_watch_status",
		label: "Lane Watch Status",
		description: "List lane watches in this Pi process.",
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "optional agent filter" })),
		}),
		async execute(_toolCallId, args) {
			const list = snapshot(args.agent?.trim() || undefined);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							ok: true,
							herdr: herdrAvailable(),
							cheap_model: cheapModelId(),
							watches: list,
						}),
					},
				],
				details: { ok: true, count: list.length },
			};
		},
	});
}
