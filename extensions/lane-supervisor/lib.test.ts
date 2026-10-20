import { expect, test } from "bun:test";
import {
	anyChildWorking,
	applyCheapVerdict,
	deferForGrandchildren,
	eventReason,
	extractAgentStatus,
	extractJournalSection,
	factsToStrings,
	formatLaneEvent,
	formatParentEvent,
	graceElapsedFollowup,
	initialWatchEvent,
	isPeerLaneOnlyStatus,
	peerNextForStatusWord,
	journalBodyMergePendingNear,
	journalSectionMergePending,
	journalSectionNoMerge,
	journalSectionStale,
	journalSectionStatus,
	journalSectionStatusWord,
	STILL_SETTLED_GRACE_SEC,
	stillSettledGraceElapsed,
	journalFrontmatterStatusWord,
	journalWatchFacts,
	nextUntil,
	normalizeStatus,
	parseCheapVerdict,
	resolveWatchKind,
	shouldNotify,
	shouldTriage,
	suggestForJournal,
	triageEvent,
	type HealthFacts,
} from "./lib.ts";

const baseHealth = (over: Partial<HealthFacts> = {}): HealthFacts => ({
	status: "working",
	ahead: null,
	dirty: null,
	journalPresent: null,
	...over,
});

test("nextUntil never includes current state", () => {
	for (const st of ["working", "idle", "done", "blocked", "unknown", "gone"] as const) {
		expect(nextUntil(st).includes(st)).toBe(false);
	}
});

test("nextUntil complementary sets", () => {
	expect(nextUntil("working")).toEqual(["idle", "done", "blocked"]);
	expect(nextUntil("unknown")).toEqual(["idle", "done", "blocked"]);
	expect(nextUntil("idle")).toEqual(["working", "blocked"]);
	expect(nextUntil("done")).toEqual(["working", "blocked"]);
	expect(nextUntil("blocked")).toEqual(["working", "idle", "done"]);
	expect(nextUntil("gone")).toEqual([]);
});

test("shouldTriage skips resumed; keeps safety/periodic", () => {
	expect(shouldTriage("idle", "idle", "settled")).toBe(false);
	expect(shouldTriage("working", "idle", "settled")).toBe(true);
	expect(shouldTriage("working", "working", "safety")).toBe(true);
	expect(shouldTriage("working", "working", "periodic")).toBe(true);
	expect(shouldTriage("working", "gone", "gone")).toBe(true);
	expect(shouldTriage("working", "blocked", "wait_error")).toBe(true);
	expect(shouldTriage("idle", "working", "resumed")).toBe(false);
	expect(shouldNotify("done", "working", "resumed")).toBe(false);
});

test("eventReason mapping", () => {
	expect(eventReason("working", "idle")).toBe("settled");
	expect(eventReason("working", "blocked")).toBe("blocked");
	expect(eventReason("idle", "working")).toBe("resumed");
	expect(eventReason("working", "gone")).toBe("gone");
});

test("resolveWatchKind prefers explicit kind then cheap label", () => {
	expect(resolveWatchKind({ kind: "cheap" })).toBe("cheap");
	expect(resolveWatchKind({ kind: "lane", label: "cheap-x" })).toBe("lane");
	expect(resolveWatchKind({ label: "cheap-exec1" })).toBe("cheap");
	expect(resolveWatchKind({ label: "A" })).toBe("lane");
	expect(resolveWatchKind({})).toBe("lane");
});

test("resolveWatchKind: peer 明示と label 接頭", () => {
	expect(resolveWatchKind({ kind: "peer" })).toBe("peer");
	expect(resolveWatchKind({ kind: "lane", label: "peer-x" })).toBe("lane");
	expect(resolveWatchKind({ kind: "cheap", label: "peer-x" })).toBe("cheap");
	expect(resolveWatchKind({ label: "peer-central" })).toBe("peer");
	expect(resolveWatchKind({ label: "P" })).toBe("lane");
});

test("triage: cheap settled は常に completion（介入中の抑止は index.ts の isIntervening）", () => {
	const t = triageEvent({
		kind: "cheap",
		reason: "settled",
		to: "idle",
		health: baseHealth({ status: "idle" }),
	});
	expect(t.signal).toBe("completion");
	expect(t.verdict).toBe("completion");
	expect(t.needsCheapReview).toBe(false);
});

test("triage: peer settled + 依頼 journal 終端 → completion（対岸作業完了）", () => {
	const t = triageEvent({
		kind: "peer",
		reason: "settled",
		to: "done",
		health: baseHealth({ status: "done", journalPresent: true, journalStatus: "terminal", ahead: 0 }),
	});
	expect(t.signal).toBe("completion");
	expect(t.verdict).toBe("completion");
	expect(t.needsCheapReview).toBe(false);
	expect(t.summary).toContain("依頼 journal");
});

test("triage: peer settled terminal + merge待ち → waiting（依頼 journal の終端ではない）", () => {
	const t = triageEvent({
		kind: "peer",
		reason: "settled",
		to: "done",
		health: baseHealth({
			status: "done",
			journalPresent: true,
			journalStatus: "terminal",
			ahead: 0,
			journalMergePending: true,
			statusWord: "merge待ち",
		}),
	});
	expect(t.signal).toBe("waiting");
	expect(t.verdict).toBe("in_progress_settled");
});

test("peerNextForStatusWord", () => {
	expect(peerNextForStatusWord("検証完了")).toBe("resume_verify");
	expect(peerNextForStatusWord("PASS")).toBe("resume_verify");
	expect(peerNextForStatusWord("差分なし")).toBe("resume_verify");
	expect(peerNextForStatusWord("FAIL-alpha-central")).toBe("deny_no_workaround");
	expect(peerNextForStatusWord("中止")).toBe("stop");
	expect(peerNextForStatusWord("延期")).toBe("stop");
	expect(peerNextForStatusWord("merge待ち")).toBe("inspect_journal");
	expect(isPeerLaneOnlyStatus("merged")).toBe(true);
});

test("graceElapsedFollowup: peer の waiting は anomaly にしない（journal 再読のみ）", () => {
	const peerWaiting = triageEvent({
		kind: "peer",
		reason: "settled",
		to: "idle",
		health: baseHealth({ status: "idle", journalPresent: true, journalStatus: "in_progress" }),
	});
	expect(peerWaiting.signal).toBe("waiting");
	expect(graceElapsedFollowup("peer", peerWaiting)).toBeNull();
	// lane の waiting は従来どおり 5 分後に anomaly へ畳む
	const laneWaiting = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "idle",
		health: baseHealth({ status: "idle" }),
	});
	expect(laneWaiting.signal).toBe("waiting");
	const afterLane = graceElapsedFollowup("lane", laneWaiting);
	expect(afterLane).not.toBeNull();
	expect(afterLane!.signal).toBe("anomaly");
	expect(afterLane!.summary).toContain("anomaly");
});

test("triage: peer settled + 依頼 journal 非終端 → waiting（5分様子見）", () => {
	const t = triageEvent({
		kind: "peer",
		reason: "settled",
		to: "idle",
		health: baseHealth({ status: "idle", journalPresent: true, journalStatus: "in_progress" }),
	});
	expect(t.signal).toBe("waiting");
	expect(t.signal).not.toBe("completion");
});

test("triage: lane settled with terminal journal → completion", () => {
	const t = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({ status: "done", journalPresent: true, journalStatus: "terminal", ahead: 2 }),
	});
	expect(t.signal).toBe("completion");
	expect(t.verdict).toBe("completion");
});

test("triage: lane idle without journal → waiting idle_wait（5分様子見）", () => {
	const t = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "idle",
		health: baseHealth({ status: "idle", journalPresent: false }),
	});
	expect(t.signal).toBe("waiting");
	expect(t.verdict).toBe("idle_wait");
	expect(t.needsCheapReview).toBe(false);
});

test("journalSectionStatus: 当該 label 節の終端判定（003 P0）", () => {
	// 進行中節のみ → in_progress（偽 completion の本番ケース）
	expect(journalSectionStatus("### Lane OS-FOLLOW（進行中）\n- 実装中\n", "OS-FOLLOW")).toBe("in_progress");
	// 見出し進行中 + 本文 PASS → 見出し優先で in_progress（部分 PASS に釣られない）
	expect(journalSectionStatus("### Lane OS-FOLLOW（進行中）\n- PASS\n", "OS-FOLLOW")).toBe("in_progress");
	// PASS 終端 → terminal
	expect(
		journalSectionStatus("### Lane OS-FOLLOW（local · demo-a2）\n- **PASS**\n- **差分なし** → **merge 不要**\n", "OS-FOLLOW"),
	).toBe("terminal");
	// 検証完了 / 中止 → terminal
	expect(journalSectionStatus("### Lane A（検証完了）\n- done\n", "A")).toBe("terminal");
	expect(journalSectionStatus("### Lane B（中止）\n- やめた\n", "B")).toBe("terminal");
	// FAIL-central → terminal
	expect(journalSectionStatus("### Lane K（local）\n- OS は FAIL-central。\n", "K")).toBe("terminal");
	// 節なし → missing
	expect(journalSectionStatus("### Lane OTHER（進行中）\n", "OS-FOLLOW")).toBe("missing");
	// marker なし → unknown
	expect(journalSectionStatus("### Lane A\n", "")).toBe("unknown");
	// 共有 journal: 他レーン節だけ → missing。当該 label 節は拾う
	const shared = "### Lane OS-LIKED（進行中）\n### Lane OS-FOLLOW（進行中）\n";
	expect(journalSectionStatus(shared, "OS-JOINREQ")).toBe("missing");
	expect(journalSectionStatus(shared, "OS-FOLLOW")).toBe("in_progress");
});

test("extractJournalSection: 節は次の見出しまで（他節の語彙に釣られない）", () => {
	const body =
		"### Lane OS-FOLLOW（進行中）\n- 実装中\n\n### Lane OS-LIKED（検証完了）\n- PASS\n";
	const section = extractJournalSection(body, "OS-FOLLOW");
	expect(section).not.toBeNull();
	expect(section!.includes("OS-LIKED")).toBe(false);
	expect(section!.includes("進行中")).toBe(true);
});

test("journalSectionStatus: 同 label 複数節 → watch 一致節を選ぶ（P0.b 案 C）", () => {
	const body =
		"### Lane OS-FOLLOW（feat/os-follow-summary · 2026-08-14 · 再証 · FAIL-central）\n" +
		"- worktree `feat/os-follow-summary`\n- **status: FAIL-central**\n\n" +
		"### Lane OS-FOLLOW（local · demo-a2 · 2026-08-14 · 最終 · 中止）\n" +
		"- worktree `feat/os-follow-fix`\n- **status: 中止**\n";
	// 今波 watch が feat/os-follow-summary → 1 節目（FAIL-central）を選ぶ
	expect(journalSectionStatus(body, "OS-FOLLOW", { branch: "feat/os-follow-summary" })).toBe("terminal");
	expect(journalSectionStale(body, "OS-FOLLOW", { branch: "feat/os-follow-summary" })).toBe(false);
	// 今波 watch が feat/os-follow-fix → 2 節目（中止）を選ぶ
	expect(journalSectionStatus(body, "OS-FOLLOW", { branch: "feat/os-follow-fix" })).toBe("terminal");
	expect(journalSectionStale(body, "OS-FOLLOW", { branch: "feat/os-follow-fix" })).toBe(false);
});

test("journalSectionStatus: 旧波終端節 + 今波進行中節 → 今波節で in_progress（P0.b）", () => {
	const body =
		"### Lane OS-FOLLOW（feat/os-follow-summary · 2026-08-14 · 再証 · FAIL-central）\n" +
		"- **status: FAIL-central**\n\n" +
		"### Lane OS-FOLLOW（local · demo-a2 · 2026-08-15 · 進行中）\n" +
		"- worktree `feat/os-follow-fix`\n- 実装中\n";
	expect(journalSectionStatus(body, "OS-FOLLOW", { branch: "feat/os-follow-fix" })).toBe("in_progress");
	expect(journalSectionStale(body, "OS-FOLLOW", { branch: "feat/os-follow-fix" })).toBe(false);
});

test("journalSectionStale: 旧波終端節のみ + watch 不一致 → stale（P0.b 案 A）", () => {
	const body =
		"### Lane OS-FOLLOW（local · demo-a2 · 2026-08-14 · 最終 · 中止）\n" +
		"- worktree `feat/os-follow-fix`\n- **status: 中止**\n";
	expect(journalSectionStatus(body, "OS-FOLLOW", { branch: "feat/os-follow-summary" })).toBe("terminal");
	expect(journalSectionStale(body, "OS-FOLLOW", { branch: "feat/os-follow-summary" })).toBe(true);
	// watch メタ無し → 検証不能。旧挙動（stale にしない）
	expect(journalSectionStale(body, "OS-FOLLOW")).toBe(false);
});

test("triage: 旧波終端節のみ + watch 不一致 → stale_section anomaly（P0.b M14 相当）", () => {
	const t = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({
			status: "done",
			journalPresent: true,
			journalStatus: "terminal",
			journalStale: true,
			ahead: 0,
		}),
	});
	expect(t.signal).toBe("anomaly");
	expect(t.verdict).toBe("stale_section");
	expect(t.needsCheapReview).toBe(false);
});

test("triage: 今波節（watch 一致）terminal → completion（P0.b 真ケース）", () => {
	const t = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({
			status: "done",
			journalPresent: true,
			journalStatus: "terminal",
			journalStale: false,
			ahead: 0,
		}),
	});
	expect(t.signal).toBe("completion");
	expect(t.verdict).toBe("completion");
});

test("factsToStrings includes journal_stale (P0.b)", () => {
	const f = factsToStrings(
		baseHealth({ status: "done", journalPresent: true, journalStatus: "terminal", journalStale: true }),
	);
	expect(f).toContain("journal_stale=1");
});

test("journalSectionMergePending: merge待ち のみ ahead 矛盾対象", () => {
	expect(journalSectionMergePending("### Lane A（merge待ち）\n", "A")).toBe(true);
	expect(journalSectionMergePending("### Lane A（検証完了）\n- merge 不要\n", "A")).toBe(false);
	expect(journalSectionMergePending("### Lane A\n", "B")).toBe(false);
});

test("triage: lane done + 進行中節のみ → in_progress_settled waiting（5分様子見）", () => {
	const t = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({ status: "done", journalPresent: true, journalStatus: "in_progress", ahead: 0 }),
	});
	expect(t.signal).toBe("waiting");
	expect(t.verdict).toBe("in_progress_settled");
	expect(t.needsCheapReview).toBe(false);
	expect(t.summary).toContain("進行中");
});

test("triage: lane settled + 終端節 → completion（003 P0 真ケース・ahead=0 でも可）", () => {
	const t = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({ status: "done", journalPresent: true, journalStatus: "terminal", ahead: 0 }),
	});
	expect(t.signal).toBe("completion");
	expect(t.verdict).toBe("completion");
});

test("triage: lane settled + terminal + ahead=0 + merge待ち → needs_review（安易 completion しない）", () => {
	const t = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({
			status: "done",
			journalPresent: true,
			journalStatus: "terminal",
			journalMergePending: true,
			ahead: 0,
		}),
	});
	expect(t.signal).toBe("anomaly");
	expect(t.verdict).toBe("needs_review");
	expect(t.needsCheapReview).toBe(true);
});

test("triage: lane settled + terminal + ahead=2 + merge待ち → completion", () => {
	const t = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({
			status: "done",
			journalPresent: true,
			journalStatus: "terminal",
			journalMergePending: true,
			ahead: 2,
		}),
	});
	expect(t.signal).toBe("completion");
});

test("triage: lane idle + journalStatus missing → waiting idle_wait", () => {
	const t = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "idle",
		health: baseHealth({ status: "idle", journalPresent: false, journalStatus: "missing" }),
	});
	expect(t.signal).toBe("waiting");
	expect(t.verdict).toBe("idle_wait");
	expect(t.needsCheapReview).toBe(false);
});

test("triage: lane idle + journalStatus unknown → waiting idle_wait", () => {
	const t = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "idle",
		health: baseHealth({ status: "idle", journalPresent: true, journalStatus: "unknown" }),
	});
	expect(t.signal).toBe("waiting");
	expect(t.verdict).toBe("idle_wait");
	expect(t.needsCheapReview).toBe(false);
});

test("factsToStrings includes journal_status (P1)", () => {
	const f = factsToStrings(
		baseHealth({ status: "done", journalPresent: true, journalStatus: "terminal", journalMergePending: false }),
	);
	expect(f).toContain("journal_status=terminal");
	expect(f).toContain("journal_merge_pending=0");
});

test("suggestForJournal: lane-facts.sh（P2 正本）の規則と同一（P0.c）", () => {
	expect(suggestForJournal({ journalStatus: "missing" })).toBe("deny_no_journal");
	expect(suggestForJournal({ journalStatus: "in_progress" })).toBe("deny_in_progress");
	// terminal + ahead≥1 → merge_candidate（statusWord 未指定は既定）
	expect(suggestForJournal({ journalStatus: "terminal", ahead: 2 })).toBe("merge_candidate");
	expect(suggestForJournal({ journalStatus: "terminal", ahead: 1 })).toBe("merge_candidate");
	// terminal + ahead<1（0 / null）→ merge_skip
	expect(suggestForJournal({ journalStatus: "terminal", ahead: 0 })).toBe("merge_skip");
	expect(suggestForJournal({ journalStatus: "terminal", ahead: null })).toBe("merge_skip");
	// unknown / 未設定 → null（suggest を出さない）
	expect(suggestForJournal({ journalStatus: "unknown" })).toBeNull();
	expect(suggestForJournal({})).toBeNull();
});

test("suggestForJournal: 中止/延期/FAIL-* + ahead≥1 → deny_terminal_no_merge（P0.c M15 相当）", () => {
	expect(suggestForJournal({ journalStatus: "terminal", ahead: 1, statusWord: "中止" })).toBe("deny_terminal_no_merge");
	expect(suggestForJournal({ journalStatus: "terminal", ahead: 2, statusWord: "延期" })).toBe("deny_terminal_no_merge");
	expect(suggestForJournal({ journalStatus: "terminal", ahead: 1, statusWord: "FAIL-central" })).toBe("deny_terminal_no_merge");
	// ahead=0 でも merge_candidate にしない
	expect(suggestForJournal({ journalStatus: "terminal", ahead: 0, statusWord: "中止" })).toBe("deny_terminal_no_merge");
});

test("suggestForJournal: PASS/検証完了 + merge不要系 → record_only（P0.c）", () => {
	expect(
		suggestForJournal({ journalStatus: "terminal", ahead: 1, statusWord: "検証完了", journalNoMerge: true }),
	).toBe("record_only");
	expect(
		suggestForJournal({ journalStatus: "terminal", ahead: 1, statusWord: "PASS", journalNoMerge: true }),
	).toBe("record_only");
	expect(suggestForJournal({ journalStatus: "terminal", ahead: 1, statusWord: "差分なし" })).toBe("record_only");
	expect(suggestForJournal({ journalStatus: "terminal", ahead: 1, statusWord: "merge済" })).toBe("record_only");
	// PASS 単独 + ahead≥1 → merge_candidate（既存挙動維持）
	expect(suggestForJournal({ journalStatus: "terminal", ahead: 1, statusWord: "PASS" })).toBe("merge_candidate");
	// merge待ち + ahead≥1 → merge_candidate（維持）
	expect(suggestForJournal({ journalStatus: "terminal", ahead: 1, statusWord: "merge待ち" })).toBe("merge_candidate");
	expect(suggestForJournal({ journalStatus: "terminal", ahead: 0, statusWord: "merge待ち" })).toBe("merge_skip");
});

test("journalSectionStatusWord: 節から status_word（lane-journal-section.sh と同一優先順）", () => {
	expect(journalSectionStatusWord("### Lane A（中止）\n- やめた\n", "A")).toBe("中止");
	expect(journalSectionStatusWord("### Lane B（実装完了）\n- PASS\n", "B")).toBe("PASS");
	expect(journalSectionStatusWord("### Lane C（進行中）\n- PASS\n", "C")).toBe("進行中");
	expect(journalSectionStatusWord("### Lane D（検証完了）\n- 差分なし → merge 不要\n", "D")).toBe("検証完了");
	expect(journalSectionStatusWord("### Lane E\n", "E")).toBeNull();
});

test("journalSectionNoMerge: merge 不要系語彙の検出（P0.c）", () => {
	expect(journalSectionNoMerge("### Lane A（検証完了）\n- 差分なし → merge 不要\n", "A")).toBe(true);
	expect(journalSectionNoMerge("### Lane B（実装完了）\n- PASS\n", "B")).toBe(false);
	expect(journalSectionNoMerge("### Lane C（merge待ち）\n- merge 依頼済み\n", "C")).toBe(false);
});

test("factsToStrings includes suggest= (P2 正本と同一規則・P0.c)", () => {
	const f = factsToStrings(
		baseHealth({ status: "done", journalPresent: true, journalStatus: "terminal", ahead: 2 }),
	);
	expect(f).toContain("journal_status=terminal");
	expect(f).toContain("suggest=merge_candidate");
	const g = factsToStrings(
		baseHealth({ status: "idle", journalPresent: true, journalStatus: "in_progress", ahead: 0 }),
	);
	expect(g).toContain("suggest=deny_in_progress");
	// journal 未設定（cheap 等）は suggest を出さない
	expect(factsToStrings(baseHealth({ status: "idle" })).some((s) => s.startsWith("suggest="))).toBe(false);
});

test("journalSectionStatus: 先頭以外の節も見出し優先（lane-journal-section.sh と同一）", () => {
	// 2 節目（節先頭に \n が付く）でも「進行中」見出し + 本文 PASS → in_progress（本文の部分 PASS に釣られない）
	const body = "### Lane OS-LIKED（検証完了）\n- PASS\n\n### Lane OS-FOLLOW（進行中）\n- PASS\n";
	expect(journalSectionStatus(body, "OS-FOLLOW")).toBe("in_progress");
	// 2 節目で見出しが終端語彙 → terminal
	const body2 = "### Lane OS-LIKED（進行中）\n\n### Lane OS-FOLLOW（検証完了）\n- done\n";
	expect(journalSectionStatus(body2, "OS-FOLLOW")).toBe("terminal");
});

test("journalSectionStatus: lane-control fixtures と同一期待（P1 正本整合）", () => {
	// fixtures/journal-in-progress.md 相当（TEST-A）
	expect(
		journalSectionStatus("### Lane TEST-A — 進行中\n\n- 実装中\n- ビルド確認中\n", "TEST-A"),
	).toBe("in_progress");
	// fixtures/journal-pass.md 相当（TEST-B）
	expect(
		journalSectionStatus("### Lane TEST-B — 実装完了\n\n- 実装完了\n- PASS\n", "TEST-B"),
	).toBe("terminal");
	// fixtures/journal-no-section.md 相当（TEST-C 節なし）
	expect(journalSectionStatus("## 計画\n- 調査\n", "TEST-C")).toBe("missing");
	// fixtures/journal-shared.md 相当: 他 label のみ → missing / 当該 label → terminal
	const shared = "### Lane OTHER-D — 検証完了\n\n- PASS\n";
	expect(journalSectionStatus(shared, "TEST-E")).toBe("missing");
	expect(journalSectionStatus(shared, "OTHER-D")).toBe("terminal");
});

test("triage: safety needs cheap review default healthy", () => {
	const t = triageEvent({
		kind: "lane",
		reason: "safety",
		to: "working",
		health: baseHealth({ status: "working" }),
	});
	expect(t.signal).toBe("healthy");
	expect(t.needsCheapReview).toBe(true);
});

test("triage: blocked/gone are anomalies without cheap", () => {
	expect(
		triageEvent({
			kind: "lane",
			reason: "blocked",
			to: "blocked",
			health: baseHealth({ status: "blocked" }),
		}).signal,
	).toBe("anomaly");
	expect(
		triageEvent({
			kind: "cheap",
			reason: "gone",
			to: "gone",
			health: baseHealth({ status: "gone" }),
		}).signal,
	).toBe("anomaly");
});

test("applyCheapVerdict ok on safety → healthy", () => {
	const base = triageEvent({
		kind: "lane",
		reason: "safety",
		to: "working",
		health: baseHealth(),
	});
	const t = applyCheapVerdict(base, { verdict: "ok", reason: "progress visible" });
	expect(t.signal).toBe("healthy");
	expect(t.verdict).toBe("healthy");
});

test("applyCheapVerdict anomaly on periodic → anomaly", () => {
	const base = triageEvent({
		kind: "lane",
		reason: "periodic",
		to: "working",
		health: baseHealth(),
	});
	const t = applyCheapVerdict(base, { verdict: "anomaly", reason: "same tool loop" });
	expect(t.signal).toBe("anomaly");
	expect(t.summary).toContain("same tool loop");
});

test("parseCheapVerdict tolerates fences and synonyms", () => {
	expect(parseCheapVerdict('{"verdict":"ok","reason":"fine"}')?.verdict).toBe("ok");
	expect(parseCheapVerdict('```json\n{"verdict":"anomaly","reason":"loop"}\n```')?.verdict).toBe(
		"anomaly",
	);
	expect(parseCheapVerdict('{"verdict":"healthy"}')?.verdict).toBe("ok");
	expect(parseCheapVerdict("status is stuck in a loop")?.verdict).toBe("anomaly");
	expect(parseCheapVerdict("all ok continue")?.verdict).toBe("ok");
	expect(parseCheapVerdict("???")).toBeNull();
});

test("formatParentEvent includes signal and no parent-wake for healthy path text", () => {
	const lane = formatParentEvent({
		kind: "lane",
		signal: "completion",
		agent: "lane-a",
		from: "working",
		to: "idle",
		reason: "settled",
		verdict: "completion",
		label: "A",
		tabId: "w1:t2",
		worktree: "/tmp/repo.slice",
		facts: ["ahead=3", "journal=yes"],
	});
	expect(lane.startsWith("LANE_EVENT:")).toBe(true);
	expect(lane.includes("signal=completion")).toBe(true);
	expect(lane.includes("facts=ahead=3;journal=yes")).toBe(true);
	expect(lane.includes("merge/撤収")).toBe(true);
	expect(lane.includes("\n")).toBe(false);

	const cheap = formatParentEvent({
		kind: "cheap",
		signal: "anomaly",
		agent: "exec1",
		from: "working",
		to: "working",
		reason: "safety",
		verdict: "stuck",
		label: "cheap-exec1",
		summary: "loop",
	});
	expect(cheap.startsWith("CHEAP_EVENT:")).toBe(true);
	expect(cheap.includes("signal=anomaly")).toBe(true);
	expect(cheap.includes("異常対応")).toBe(true);

	const cheapDone = formatParentEvent({
		kind: "cheap",
		signal: "completion",
		agent: "exec1",
		from: "working",
		to: "done",
		reason: "settled",
		verdict: "completion",
		label: "cheap-exec1",
	});
	expect(cheapDone.includes("review を read")).toBe(true);
	expect(cheapDone.includes("未実施のまま完了を言うな")).toBe(true);
	expect(cheapDone.includes("\n")).toBe(false);
});

test("formatParentEvent: peer は PEER_EVENT・親起こし文面に merge/撤収を書かない", () => {
	const peer = formatParentEvent({
		kind: "peer",
		signal: "completion",
		agent: "central-sup",
		from: "working",
		to: "done",
		reason: "settled",
		verdict: "completion",
		label: "peer-central",
		tabId: "w2:t1",
		facts: ["journal_status=terminal", "suggest=merge_candidate", "journal_merge_pending=1", "status_word=FAIL-central", "ahead=2"],
	});
	expect(peer.startsWith("PEER_EVENT: kind=peer signal=completion")).toBe(true);
	expect(peer.includes("merge")).toBe(false);
	expect(peer.includes("撤収")).toBe(false);
	expect(peer.includes("next=deny_no_workaround")).toBe(true);
	expect(peer.includes("workaround 禁止")).toBe(true);
	expect(peer.includes("journal_status=terminal")).toBe(true);
	expect(peer.includes("status_word=FAIL-central")).toBe(true);
	expect(peer.includes("suggest=")).toBe(false);
	expect(peer.includes("\n")).toBe(false);
});

test("formatParentEvent: lane completion は従来どおり merge/撤収 を含む", () => {
	const lane = formatParentEvent({
		kind: "lane",
		signal: "completion",
		agent: "lane-a",
		from: "working",
		to: "idle",
		reason: "settled",
		verdict: "completion",
	});
	expect(lane.startsWith("LANE_EVENT: kind=lane")).toBe(true);
	expect(lane.includes("merge/撤収")).toBe(true);
});

test("formatLaneEvent backward compatible wrapper", () => {
	const lane = formatLaneEvent({
		kind: "lane",
		agent: "lane-a",
		from: "working",
		to: "idle",
		reason: "settled",
		label: "A",
	});
	expect(lane.startsWith("LANE_EVENT:")).toBe(true);
	expect(lane.includes("signal=")).toBe(true);
});

test("initialWatchEvent notifies already settled/blocked", () => {
	expect(initialWatchEvent("idle")).toEqual({
		from: "unknown",
		reason: "settled",
		detail: "already_settled",
	});
	expect(initialWatchEvent("done")?.reason).toBe("settled");
	expect(initialWatchEvent("blocked")?.reason).toBe("blocked");
	expect(initialWatchEvent("working")).toBeNull();
	expect(initialWatchEvent("gone")).toBeNull();
	const ev = initialWatchEvent("idle");
	expect(ev && shouldTriage(ev.from, "idle", ev.reason)).toBe(true);
});

test("P3/P5: 親 settled(done) + children working → deferred（親を起こさない・anomaly にしない）", () => {
	const triage = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({ status: "done", journalPresent: true, journalStatus: "terminal", ahead: 0 }),
	});
	expect(triage.signal).toBe("completion");
	const t = deferForGrandchildren(
		triage,
		anyChildWorking([
			{ name: "exec1", status: "working" },
			{ name: "exec2", status: "idle" },
		]),
	);
	expect(t.signal).toBe("deferred");
	expect(t.verdict).toBe("children_alive");
	expect(t.needsCheapReview).toBe(false);
});

test("P3: children 無し / 非 working → 従来どおり completion（真 completion は通す）", () => {
	const triage = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({ status: "done", journalPresent: true, journalStatus: "terminal", ahead: 0 }),
	});
	expect(deferForGrandchildren(triage, anyChildWorking([])).signal).toBe("completion");
	expect(
		deferForGrandchildren(triage, anyChildWorking([{ status: "idle" }, { status: "done" }])).signal,
	).toBe("completion");
});

test("P3/P5: 孫 working 中は nudge（premature_settled）も deferred にする（P7）", () => {
	const premature = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({ status: "done", journalPresent: false, journalStatus: "missing" }),
	});
	expect(premature.signal).toBe("waiting");
	expect(premature.verdict).toBe("premature_settled");
	const t = deferForGrandchildren(premature, true);
	expect(t.signal).toBe("deferred");
	expect(t.verdict).toBe("premature_settled");
	expect(t.needsCheapReview).toBe(false);
	// 孫がいなければ nudge のまま（親へは出さない）
	expect(deferForGrandchildren(premature, false).signal).toBe("waiting");
	// healthy は孫 working でも変えない
	const healthy = triageEvent({
		kind: "lane",
		reason: "safety",
		to: "working",
		health: baseHealth({ status: "working" }),
	});
	expect(deferForGrandchildren(healthy, true).signal).toBe("healthy");
});

test("anyChildWorking: working のみ true（他状態は false）", () => {
	expect(anyChildWorking([{ status: "working" }])).toBe(true);
	expect(anyChildWorking([{ status: "WORKING" }])).toBe(true);
	expect(anyChildWorking([{ status: "idle" }, { status: "done" }])).toBe(false);
	expect(anyChildWorking([{ status: "unknown" }])).toBe(false);
	expect(anyChildWorking([{ status: "blocked" }])).toBe(false);
	expect(anyChildWorking([{ status: "gone" }])).toBe(false);
	expect(anyChildWorking([])).toBe(false);
	expect(anyChildWorking([{ status: null }])).toBe(false);
});

test("extractJournalSection: label 部分一致で branch 名だけの見出しも拾う（`## Lane feat/<branch>` 型）", () => {
	// 008 実例: 見出しに label が無く feat/<branch> だけ。label 部分一致で拾える
	const body = "# 記録\n\n## Lane feat/admin-report-filter — merged\n\n- 状態: **merge待ち**\n";
	const section = extractJournalSection(body, "admin-report-filter");
	expect(section).not.toBeNull();
	expect(section!.includes("merge待ち")).toBe(true);
	expect(journalSectionStatus(body, "admin-report-filter")).toBe("terminal");
});

test("extractJournalSection: Lane 接頭辞が無い branch 見出しも branch 部分一致で拾う（`## feat/<branch>` 型）", () => {
	// 007 実例: `## feat/admin-id-links`（Lane 無し）。branch 部分一致で拾える
	const body = "# 記録\n\n## feat/admin-id-links\n\nstatus: merge待ち\n";
	const section = extractJournalSection(body, "admin-id-links", "feat/admin-id-links");
	expect(section).not.toBeNull();
	expect(section!.includes("merge待ち")).toBe(true);
	expect(journalSectionStatus(body, "admin-id-links", { branch: "feat/admin-id-links" })).toBe("terminal");
	// label とも feat/<branch> とも一致しない見出しは拾わない（# 無し本文行は節にしない）
	const body2 = "# 記録\n\n## 別件\n- branch: feat/admin-id-links の話\n";
	expect(extractJournalSection(body2, "admin-id-links", "feat/admin-id-links")).toBeNull();
});

test("extractJournalSection: H1 `# Lane <label>` も節にする（レーンが書く形）", () => {
	const body = "# Lane C — feat/settings-section-align\n\nstatus: merge待ち\n";
	const section = extractJournalSection(body, "Lane C", "feat/settings-section-align");
	expect(section).not.toBeNull();
	expect(section!.includes("merge待ち")).toBe(true);
	expect(journalSectionStatus(body, "Lane C", { branch: "feat/settings-section-align" })).toBe("terminal");
});

test("P5: 見出しは先に Lane <label> / 見出し先頭 <branch>、落ちたら部分一致", () => {
	// 厳密一致（Lane <label>）がある → 部分一致だけの節は選ばない
	const body =
		"### OS-FOLLOW 残件（検証完了）\n- done\n\n### Lane OS-FOLLOW（進行中）\n- 実装中\n";
	expect(journalSectionStatus(body, "OS-FOLLOW")).toBe("in_progress");
	// 見出し先頭 <branch>（厳密）が部分一致節より優先される
	const body2 =
		"### 残件: feat/admin-id-links（進行中）\n- 作業中\n\n## feat/admin-id-links\n\nstatus: merge待ち\n";
	expect(journalSectionStatus(body2, "admin-id-links", { branch: "feat/admin-id-links" })).toBe("terminal");
	// 厳密一致が無ければ部分一致へ（`## Lane feat/<branch>` 型）
	const body3 = "# 記録\n\n## Lane feat/admin-report-filter — merged\n\n- 状態: **merge待ち**\n";
	expect(journalSectionStatus(body3, "admin-report-filter")).toBe("terminal");
	// `Lane <label>` の境界（OS-FOLLOW が OS-FOLLOWING に釣られない）: 部分一致でも拾う OS-FOLLOWING 節より
	// 厳密一致の OS-FOLLOW 節を優先する
	const body4 =
		"### Lane OS-FOLLOWING（検証完了）\n- done\n\n### Lane OS-FOLLOW（進行中）\n- 実装中\n";
	expect(journalSectionStatus(body4, "OS-FOLLOW")).toBe("in_progress");
});

test("P6: journalBodyMergePendingNear は label/branch 近傍（±2 行）の merge待ち だけ数える", () => {
	// 見出し（label 行）の近くに merge待ち → true
	expect(
		journalBodyMergePendingNear("## feat/admin-id-links\n\nstatus: merge待ち\n", "admin-id-links", "feat/admin-id-links"),
	).toBe(true);
	// 同じ行に label と merge待ち → true（表の行）
	expect(journalBodyMergePendingNear("| OS-FOLLOW | merge待ち |\n", "OS-FOLLOW")).toBe(true);
	// 隣レーンの merge待ち と離れた位置の自レーン言及 → false（全文スキャンしない）
	const body =
		"### Lane OS-LIKED — merge待ち\n- merge 依頼済み\n\n\n### Lane OS-FOLLOW の件は次回\n- メモ\n";
	expect(journalBodyMergePendingNear(body, "OS-FOLLOW")).toBe(false);
	// marker なし / merge待ち 無し → false
	expect(journalBodyMergePendingNear("### Lane A\n", "")).toBe(false);
	expect(journalBodyMergePendingNear("### Lane OS-FOLLOW（進行中）\n- 実装中\n", "OS-FOLLOW")).toBe(false);
});

test("triage: 見出し欠落 + ahead≥1 + 本文 merge待ち → done は merge_pending_no_heading waiting", () => {
	const idle = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "idle",
		health: baseHealth({
			status: "idle",
			journalPresent: false,
			journalStatus: "missing",
			ahead: 1,
			journalBodyMergePending: true,
		}),
	});
	expect(idle.signal).toBe("waiting");
	expect(idle.verdict).toBe("idle_wait");
	const t = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({
			status: "done",
			journalPresent: false,
			journalStatus: "missing",
			ahead: 1,
			journalBodyMergePending: true,
		}),
	});
	expect(t.signal).toBe("waiting");
	expect(t.verdict).toBe("merge_pending_no_heading");
	expect(t.needsCheapReview).toBe(false);
	expect(t.summary).toContain("見出し");
	const t2 = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({
			status: "done",
			journalPresent: false,
			journalStatus: "missing",
			ahead: 1,
			journalBodyMergePending: false,
		}),
	});
	expect(t2.signal).toBe("waiting");
	expect(t2.verdict).toBe("premature_settled");
});

test("triage: 見出し欠落 + ahead=0 + 本文 merge待ち → done は premature waiting", () => {
	const t = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({
			status: "done",
			journalPresent: false,
			journalStatus: "missing",
			ahead: 0,
			journalBodyMergePending: true,
		}),
	});
	expect(t.signal).toBe("waiting");
	expect(t.verdict).toBe("premature_settled");
});

test("factsToStrings includes journal_body_merge_pending", () => {
	const f = factsToStrings(baseHealth({ status: "done", journalStatus: "missing", journalBodyMergePending: true }));
	expect(f).toContain("journal_body_merge_pending=1");
});

test("shouldTriage: deferred_settled は常に triage する（孫終了後の再評価）", () => {
	expect(shouldTriage("idle", "idle", "deferred_settled")).toBe(true);
	expect(shouldTriage("working", "idle", "deferred_settled")).toBe(true);
});

test("P7 M17: lane idle/done + journal 非終端 + 孫なし → すぐ親 signal にしない", () => {
	const idle = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "idle",
		health: baseHealth({ status: "idle", journalPresent: true, journalStatus: "in_progress" }),
	});
	expect(idle.signal).toBe("waiting");
	expect(idle.verdict).toBe("idle_wait");
	const done = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({ status: "done", journalPresent: true, journalStatus: "in_progress" }),
	});
	expect(done.signal).toBe("waiting");
	expect(done.signal).not.toBe("completion");
	expect(done.signal).not.toBe("anomaly");
});

test("P7 M18: journal 終端 + merge_candidate → completion 維持", () => {
	const health = baseHealth({
		status: "done",
		journalPresent: true,
		journalStatus: "terminal",
		journalMergePending: true,
		statusWord: "merge待ち",
		ahead: 1,
	});
	expect(suggestForJournal(health)).toBe("merge_candidate");
	const t = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health,
	});
	expect(t.signal).toBe("completion");
	const idleTerminal = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "idle",
		health: { ...health, status: "idle" },
	});
	expect(idleTerminal.signal).toBe("completion");
});

test("P7 M19: 44s は様子見中・5分で親へ出してよい", () => {
	const t0 = Date.parse("2026-08-28T05:15:39Z");
	expect(stillSettledGraceElapsed(null, t0)).toBe(false);
	expect(stillSettledGraceElapsed(t0, t0 + 44_000)).toBe(false);
	expect(stillSettledGraceElapsed(t0, t0 + STILL_SETTLED_GRACE_SEC * 1000 - 1)).toBe(false);
	expect(stillSettledGraceElapsed(t0, t0 + STILL_SETTLED_GRACE_SEC * 1000)).toBe(true);
});

test("shouldTriage: still_settled_grace は from===to でも triage する", () => {
	expect(shouldTriage("idle", "idle", "still_settled_grace")).toBe(true);
	expect(shouldTriage("done", "done", "still_settled_grace")).toBe(true);
});

test("P7 M20: 孫 working 中の親 done は deferred（007 維持）", () => {
	const done = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({ status: "done", journalPresent: true, journalStatus: "in_progress" }),
	});
	expect(deferForGrandchildren(done, true).signal).toBe("deferred");
	const terminal = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "done",
		health: baseHealth({ status: "done", journalPresent: true, journalStatus: "terminal", ahead: 1 }),
	});
	expect(deferForGrandchildren(terminal, true).signal).toBe("deferred");
	expect(deferForGrandchildren(terminal, true).verdict).toBe("children_alive");
});

test("shouldTriage: journal_reread は from===to でも triage する", () => {
	expect(shouldTriage("idle", "idle", "journal_reread")).toBe(true);
});

test("M21: frontmatter 検証完了 + Lane-N 節が空でも terminal（lane-n 型）", () => {
	const body =
		"---\nstatus: 検証完了\n---\n\n# 書込操作と結果確認方法\n\n## Lane-N feat/write-confirm-catalog\n\n## 表\n";
	expect(journalFrontmatterStatusWord(body)).toBe("検証完了");
	const facts = journalWatchFacts(body, "Lane N", { branch: "feat/write-confirm-catalog" });
	expect(facts.journalStatus).toBe("terminal");
	expect(facts.statusWord).toBe("検証完了");
	expect(facts.journalStale).toBe(false);
	const t = triageEvent({
		kind: "lane",
		reason: "settled",
		to: "idle",
		health: baseHealth({
			status: "idle",
			journalPresent: true,
			journalStatus: facts.journalStatus,
			statusWord: facts.statusWord,
			ahead: 0,
		}),
	});
	expect(t.signal).toBe("completion");
});

test("journalWatchFacts: frontmatter 進行中なら節に落とす", () => {
	const body =
		"---\nstatus: 進行中\n---\n\n## Lane A（検証完了）\n- done\n";
	expect(journalWatchFacts(body, "A").journalStatus).toBe("terminal");
	expect(journalWatchFacts(body, "A").statusWord).toBe("検証完了");
	const onlyFm = "---\nstatus: 進行中\n---\n\n# 題\n";
	expect(journalWatchFacts(onlyFm, "A").journalStatus).toBe("missing");
});

test("FAIL-<module> 汎用形: FAIL-central / FAIL-client 以外も終端（読み互換）", () => {
	// FAIL-central（既存語彙）は従来どおり終端
	expect(journalSectionStatus("### Lane K（local）\n- OS は FAIL-central。\n", "K")).toBe("terminal");
	// 汎用 FAIL-<module>（例 FAIL-core）も終端
	expect(journalSectionStatus("### 依頼 central（local）\n- 契約修復は FAIL-core。\n", "central")).toBe("terminal");
	expect(journalSectionStatusWord("### 依頼 central（local）\n- FAIL-core。\n", "central")).toBe("FAIL-core");
	expect(suggestForJournal({ journalStatus: "terminal", ahead: 1, statusWord: "FAIL-core" })).toBe(
		"deny_terminal_no_merge",
	);
	// frontmatter の FAIL-<module> も終端
	const fm = "---\nstatus: FAIL-main-proto\n---\n\n# 対岸依頼\n- 契約が壊れている\n";
	expect(journalFrontmatterStatusWord(fm)).toBe("FAIL-main-proto");
	expect(journalWatchFacts(fm, "依頼").journalStatus).toBe("terminal");
});

test("extractAgentStatus walks nested herdr JSON", () => {
	expect(extractAgentStatus({ result: { agent: { agent_status: "blocked" } } })).toBe("blocked");
	expect(extractAgentStatus({ agents: [] })).toBeNull();
	expect(normalizeStatus("BLOCKED")).toBe("blocked");
	expect(normalizeStatus("nope")).toBe("unknown");
});
