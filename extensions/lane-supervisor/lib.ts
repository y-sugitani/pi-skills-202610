/** Pure helpers for lane-supervisor. No Pi / herdr I/O. */

export type LaneStatus = "working" | "idle" | "done" | "blocked" | "unknown" | "gone";

export type WatchKind = "cheap" | "lane" | "peer";

export type LaneEventReason =
	| "settled"
	| "blocked"
	| "resumed"
	| "safety"
	| "gone"
	| "wait_error"
	| "periodic"
	| "deferred_settled"
	| "still_settled_grace"
	| "journal_reread";

/** Parent is woken only for these. healthy never reaches the parent model. */
export type ParentSignal = "completion" | "anomaly";

export type TriageVerdict =
	| "completion"
	| "premature_settled"
	| "in_progress_settled"
	| "idle_wait"
	| "stale_section"
	| "blocked"
	| "gone"
	| "wait_error"
	| "stuck"
	| "healthy"
	| "needs_review"
	| "children_alive"
	| "merge_pending_no_heading";

/** 003 P0: 当該 label 節の状態。completion は terminal のみ。 */
export type JournalStatus = "in_progress" | "terminal" | "missing" | "unknown";

export type HealthFacts = {
	status: LaneStatus;
	ahead: number | null;
	dirty: boolean | null;
	journalPresent: boolean | null;
	/** P1: 当該 label 節の状態（003 P0）。in_progress=節あり終端語彙なし / terminal=終端語彙あり / missing=節なし / unknown=判定不能 */
	journalStatus?: JournalStatus | null;
	/** terminal 語彙が merge 成果前提（merge待ち）か。ahead=0 との矛盾判定に使う */
	journalMergePending?: boolean | null;
	/** P0.b: 当該 label 節が全て watch の worktree/branch と不一致（旧波の残骸）か */
	journalStale?: boolean | null;
	/** P0.c: 当該 label 節の status_word（lane-journal-section.sh と同一語彙・同一優先順） */
	statusWord?: string | null;
	/** P0.c: 節が merge 不要系語彙（merge不要/差分なし/…）を含むか。PASS・検証完了 の record_only 判定に使う */
	journalNoMerge?: boolean | null;
	/** 見出し欠落（missing）時に、本文全体に merge待ち 系語彙があり label/branch の痕跡もあるか。N=3 再 spawn 除外判定に使う */
	journalBodyMergePending?: boolean | null;
	detail?: string;
};

export type TriageResult = {
	/** Final parent routing. healthy = do not wake parent. deferred = 孫稼働中は親を起こさず拡張内で待つ。 waiting = 非終端 settled の 5 分様子見（親へ出さない）。 */
	signal: ParentSignal | "healthy" | "deferred" | "waiting";
	verdict: TriageVerdict;
	/** Run cheap model (deepseek flash) before finalizing when true. */
	needsCheapReview: boolean;
	facts: string[];
	summary: string;
};

/** P7: 孫完了直後、次 cheap を出す猶予。 */
export const GRANDCHILD_SETTLE_DEBOUNCE_SEC = 8;
/** 非終端 idle/done を親に出す前の様子見。nudge しない（working→idle ループの主因）。 */
export const STILL_SETTLED_GRACE_SEC = 300;
/** idle/done 中に journal を機械再読する間隔（親トークンなし・安い model なし）。 */
export const JOURNAL_REREAD_SEC = 30;

/** kind 明示 > label の cheap* / peer* 接頭 > lane。安委譲・レーン本体・対岸監督のイベントを分ける。 */
export function resolveWatchKind(input: { kind?: string | null; label?: string | null }): WatchKind {
	const k = (input.kind ?? "").trim().toLowerCase();
	if (k === "cheap" || k === "lane" || k === "peer") return k;
	const label = (input.label ?? "").trim().toLowerCase();
	if (label.startsWith("cheap")) return "cheap";
	if (label.startsWith("peer")) return "peer";
	return "lane";
}

export function normalizeStatus(raw: string | null | undefined): LaneStatus {
	const s = (raw ?? "").trim().toLowerCase();
	if (s === "working" || s === "idle" || s === "done" || s === "blocked" || s === "unknown" || s === "gone") {
		return s;
	}
	return "unknown";
}

/** Complementary states to wait for. Never include the current state (avoids instant-return loops). */
export function nextUntil(status: LaneStatus): LaneStatus[] {
	switch (status) {
		case "working":
		case "unknown":
			return ["idle", "done", "blocked"];
		case "idle":
		case "done":
			return ["working", "blocked"];
		case "blocked":
			return ["working", "idle", "done"];
		case "gone":
			return [];
	}
}

export function eventReason(from: LaneStatus, to: LaneStatus): LaneEventReason {
	if (to === "gone") return "gone";
	if (to === "blocked") return "blocked";
	if (to === "working" && (from === "idle" || from === "done" || from === "blocked")) return "resumed";
	if (to === "idle" || to === "done") return "settled";
	return "settled";
}

/**
 * Raw herdr transition filter (before triage).
 * resumed は捨てる。safety/periodic は triage へ（healthy なら親に送らない）。
 */
export function shouldTriage(from: LaneStatus, to: LaneStatus, reason: LaneEventReason): boolean {
	if (reason === "resumed") return false;
	if (
		reason === "safety" ||
		reason === "periodic" ||
		reason === "gone" ||
		reason === "wait_error" ||
		reason === "deferred_settled" ||
		reason === "still_settled_grace" ||
		reason === "journal_reread"
	) {
		return true;
	}
	return from !== to;
}

/** @deprecated use shouldTriage + triageEvent. Kept for older tests/callers. */
export function shouldNotify(from: LaneStatus, to: LaneStatus, reason: LaneEventReason): boolean {
	return shouldTriage(from, to, reason);
}

/** watch 開始時にすでに settled/blocked なら、遷移を待たず即通知する。 */
export function initialWatchEvent(
	status: LaneStatus,
): { from: LaneStatus; reason: LaneEventReason; detail: string } | null {
	if (status === "idle" || status === "done") {
		return { from: "unknown", reason: "settled", detail: "already_settled" };
	}
	if (status === "blocked") {
		return { from: "unknown", reason: "blocked", detail: "already_settled" };
	}
	return null;
}

/**
 * lane-facts.sh（P2 正本）の suggest 規則と同一（P0.c: status_word で分岐）:
 * missing → deny_no_journal / in_progress → deny_in_progress /
 * terminal: 中止・延期・FAIL-* → deny_terminal_no_merge /
 * merge待ち → ahead≥1 ? merge_candidate : merge_skip /
 * PASS・検証完了 + merge不要系（journalNoMerge）→ record_only /
 * 他 terminal → ahead≥1 ? merge_candidate : merge_skip。
 * unknown / 未設定は null（suggest を出さない）。
 */
export function suggestForJournal(h: {
	journalStatus?: JournalStatus | null;
	ahead?: number | null;
	statusWord?: string | null;
	journalNoMerge?: boolean | null;
}): string | null {
	const s = h.journalStatus;
	if (s === "missing") return "deny_no_journal";
	if (s === "in_progress") return "deny_in_progress";
	if (s === "terminal") {
		const w = (h.statusWord ?? "").trim();
		if (w === "中止" || w === "延期" || w.startsWith("FAIL-")) return "deny_terminal_no_merge";
		if (w === "merge待ち" || w === "merge 待ち") {
			return h.ahead != null && h.ahead >= 1 ? "merge_candidate" : "merge_skip";
		}
		if (h.journalNoMerge === true || JOURNAL_NO_MERGE_WORDS.some((nw) => nw === w)) {
			return "record_only";
		}
		return h.ahead != null && h.ahead >= 1 ? "merge_candidate" : "merge_skip";
	}
	return null;
}

export function factsToStrings(h: HealthFacts): string[] {
	const out: string[] = [`status=${h.status}`];
	if (h.ahead != null) out.push(`ahead=${h.ahead}`);
	if (h.dirty != null) out.push(`dirty=${h.dirty ? 1 : 0}`);
	if (h.journalPresent != null) out.push(`journal=${h.journalPresent ? "yes" : "no"}`);
	if (h.journalStatus != null) out.push(`journal_status=${h.journalStatus}`);
	if (h.journalMergePending != null) out.push(`journal_merge_pending=${h.journalMergePending ? 1 : 0}`);
	if (h.journalStale != null) out.push(`journal_stale=${h.journalStale ? 1 : 0}`);
	if (h.statusWord != null) out.push(`status_word=${h.statusWord}`);
	if (h.journalNoMerge != null) out.push(`journal_no_merge=${h.journalNoMerge ? 1 : 0}`);
	if (h.journalBodyMergePending != null) out.push(`journal_body_merge_pending=${h.journalBodyMergePending ? 1 : 0}`);
	const suggest = suggestForJournal(h);
	if (suggest) out.push(`suggest=${suggest}`);
	if (h.detail) out.push(`detail=${h.detail.replaceAll(/\s+/g, " ").slice(0, 120)}`);
	return out;
}

/**
 * 終端語彙（journal 節が「完了」と判定できる語）。
 * skills/lane-control/scripts/lane-journal-section.sh（facts CLI の正本）と
 * 同一語彙・同一順序で整合させる（fixture も共有）。
 * journal の status 語彙（進行中 | merge待ち | merged | 検証完了 | 中止 | 延期）と
 * 実 journal 表記（PASS / FAIL-<module> / 差分なし → merge 不要）に合わせる。
 * FAIL は FAIL-<module> が本則。汎用 FAIL-* は firstTerminalWord の regex フォールバックで拾う。
 */
export const JOURNAL_TERMINAL_WORDS = [
	"PASS",
	"merge待ち",
	"merge 待ち",
	"merge済",
	"merge 済",
	"merged",
	"検証完了",
	"中止",
	"延期",
	"merge不要",
	"merge 不要",
	"検証のみ",
	"調査のみ",
	"変更なし",
	"差分なし",
	"記録のみ",
] as const;

/** ahead=0 と矛盾する終端語彙（merge 成果が前提）。ahead=0 のとき completion を保留する。 */
export const JOURNAL_MERGE_REQUIRING_WORDS = ["merge待ち", "merge 待ち"] as const;

/** 依頼 journal に使ってはいけないレーン語彙。peer では終端にしない。 */
export const PEER_LANE_ONLY_STATUS_WORDS = ["merge待ち", "merge 待ち", "merge済", "merge 済", "merged"] as const;

export type PeerNext = "resume_verify" | "deny_no_workaround" | "stop" | "inspect_journal";

export function isPeerLaneOnlyStatus(word: string | null | undefined): boolean {
	const w = (word ?? "").trim();
	return (PEER_LANE_ONLY_STATUS_WORDS as readonly string[]).includes(w);
}

/** 依頼 journal の status_word → 依頼元が取る手。 */
export function peerNextForStatusWord(word: string | null | undefined): PeerNext {
	const w = (word ?? "").trim();
	if (isPeerLaneOnlyStatus(w)) return "inspect_journal";
	if (w.startsWith("FAIL-")) return "deny_no_workaround";
	if (w === "中止" || w === "延期") return "stop";
	if (w === "検証完了" || w === "PASS" || w === "PASS") return "resume_verify";
	if (JOURNAL_NO_MERGE_WORDS.some((nw) => nw === w)) return "resume_verify";
	return "inspect_journal";
}

export function peerParentHint(next: PeerNext): string {
	switch (next) {
		case "resume_verify":
			return "親: next=resume_verify。FAIL レーンは merge しない。受信検証を空き枠の新レーンに。対岸タブは閉じるな。peer watch は extension が外す。";
		case "deny_no_workaround":
			return "親: next=deny_no_workaround。workaround 禁止。次 module なら新規依頼。でなければユーザーへ。対岸タブは閉じるな。";
		case "stop":
			return "親: next=stop。受信検証しない。progress にポインタ。対岸タブは閉じるな。";
		default:
			return "親: next=inspect_journal。依頼 journal の終端語彙を確認。対岸タブは閉じるな。merge/撤収するな。";
	}
}

/** P0.c: merge 不要系の終端語彙。PASS・検証完了 と併せて record_only を導く（lane-journal-section.sh NO_MERGE_WORDS と同一）。 */
export const JOURNAL_NO_MERGE_WORDS = [
	"merge不要",
	"merge 不要",
	"差分なし",
	"変更なし",
	"検証のみ",
	"調査のみ",
	"記録のみ",
	"merge済",
	"merge 済",
	"merged",
] as const;

/**
 * 共有 journal から当該レーンの節（見出し〜次の見出し/EOF）を全て切り出す。見出し行を含む。
 * 同 label の旧波節と今波節が共存しうるため複数返す。
 * 見出し検出は P5: 先に厳密一致（見出し内 `Lane <label>` / 見出し先頭が `<branch>`、例 `## feat/admin-id-links`）
 * を試し、落ちたときだけ label / branch の部分一致（substring）で拾う（例: `## Lane feat/admin-report-filter — merged`）。
 * 本文行（# 無し）が branch 名を含んでも節の切れ目にしないため見出しの `#` を必須にする。
 * H1 `# Lane <label>`（レーンが実際に書く形）も拾う。label/branch が無いタイトル行は当たらない。
 */
export function extractJournalSections(body: string, marker: string, branch?: string | null): string[] {
	const m = (marker ?? "").trim();
	if (!m) return [];
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const br = (branch ?? "").trim();
	// 見出し（`#+` と前後の空白を除いた先頭行）を返す。
	const sectionTail = `[^\\n]*(?:\\n[\\s\\S]*?)?(?=\\n#+\\s|$)`;
	const collect = (re: RegExp): string[] => {
		const out: string[] = [];
		let hit: RegExpExecArray | null;
		while ((hit = re.exec(body)) !== null) {
			out.push(hit[0]);
			if (hit.index === re.lastIndex) re.lastIndex += 1;
		}
		return out;
	};
	// P5: 厳密一致。`Lane <label>` の直後に識別子継続文字が無いこと（OS-FOLLOW が OS-FOLLOWING に釣られない）。
	const strict: string[] = [];
	for (const s of collect(new RegExp(`(^|\\n)#{1,}[^\\n]*Lane\\s+${esc(m)}(?![-A-Za-z0-9_])${sectionTail}`, "g"))) {
		strict.push(s);
	}
	if (br) {
		for (const s of collect(new RegExp(`(^|\\n)#{1,}\\s*${esc(br)}[^\\n]*${sectionTail}`, "g"))) {
			strict.push(s);
		}
	}
	const dedup = [...new Set(strict)];
	if (dedup.length > 0) return dedup;
	// P5: 厳密一致が無いときだけ部分一致（従来挙動）。
	const alternatives = [esc(m)];
	if (br) alternatives.push(esc(br));
	return collect(
		new RegExp(`(^|\\n)#{1,}[^\\n]*(?:${alternatives.join("|")})[^\\n]*${sectionTail}`, "g"),
	);
}

/** 当該レーンの最初の節。節が無ければ null。 */
export function extractJournalSection(body: string, marker: string, branch?: string | null): string | null {
	return extractJournalSections(body, marker, branch)[0] ?? null;
}

/** 節（見出し+本文）が watch の worktree/branch に紐づくか。メタ無しは検証不能 → true。 */
function sectionMatchesWatch(section: string, worktree: string, branch: string): boolean {
	if (branch && section.includes(branch)) return true;
	if (worktree) {
		if (section.includes(worktree)) return true;
		const base = worktree.split("/").pop() ?? "";
		if (base && section.includes(base)) return true;
	}
	return false;
}

/**
 * 当該 label の節のうち watch に紐づく節を選ぶ（P0.b: 共有 journal に旧波節が残る）。
 * watch メタ無し or 一致節なし → 先頭節。stale は呼び出し側で判定。
 */
function selectJournalSection(
	body: string,
	marker: string,
	worktree?: string | null,
	branch?: string | null,
): { section: string | null; stale: boolean } {
	const m = (marker ?? "").trim();
	if (!m) return { section: null, stale: false };
	const sections = extractJournalSections(body, m, branch);
	if (sections.length === 0) return { section: null, stale: false };
	const wt = (worktree ?? "").trim();
	const br = (branch ?? "").trim();
	if (!wt && !br) return { section: sections[0], stale: false };
	const matched = sections.find((s) => sectionMatchesWatch(s, wt, br));
	if (matched) return { section: matched, stale: false };
	return { section: sections[0], stale: true };
}

function textHasWord(text: string, w: string): boolean {
	// ASCII 語は単語境界で拾う（bypass 等の部分一致を避ける）。日本語は部分一致でよい
	if (/^[\x00-\x7F]+$/.test(w)) {
		return new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
	}
	return text.includes(w);
}

/** テキスト内で最初にマッチする終端語彙（JOURNAL_TERMINAL_WORDS 順）。無ければ null。 */
function firstTerminalWord(text: string): string | null {
	for (const w of JOURNAL_TERMINAL_WORDS) {
		if (textHasWord(text, w)) return w;
	}
	// FAIL-<module> 汎用形。FAIL-central / FAIL-client は語彙側（読み互換）。
	const fail = text.match(/\bFAIL-[A-Za-z0-9_.\-]+/);
	if (fail) return fail[0];
	return null;
}

function sectionHasTerminalWord(section: string): boolean {
	return firstTerminalWord(section) !== null;
}

/**
 * 003 P0: 当該 label 節の終端判定。
 * - 見出しに「進行中」があり終端語彙が無い → in_progress（見出しが最新状態の宣言。本文の部分 PASS に釣られない）
 * - 節（見出し+本文）に終端語彙 → terminal
 * - 節なし → missing / marker なし → unknown
 * P0.b: watch の worktree/branch が渡れば、一致する節（今波）だけを見る。
 */
export function journalSectionStatus(
	body: string,
	marker: string,
	opts?: { worktree?: string | null; branch?: string | null },
): JournalStatus {
	const m = (marker ?? "").trim();
	if (!m) return "unknown";
	const { section } = selectJournalSection(body, m, opts?.worktree, opts?.branch);
	if (!section) return "missing";
	// 節は先頭に \n を含む（先頭以外の見出し）。lane-journal-section.sh の lstrip("\n") と同じく剥がしてから見出しを取る
	const heading = section.replace(/^\n+/, "").split(/\n/, 1)[0];
	if (heading.includes("進行中") && !sectionHasTerminalWord(heading)) return "in_progress";
	if (sectionHasTerminalWord(section)) return "terminal";
	return "in_progress";
}

/** YAML frontmatter の `status:`。終端語彙があればその語、進行中、その他の生値、無ければ null。 */
export function journalFrontmatterStatusWord(body: string): string | null {
	const t = (body ?? "").replace(/^\uFEFF/, "");
	if (!t.startsWith("---")) return null;
	const rest = t.slice(3);
	const nl = rest.startsWith("\n") ? rest.slice(1) : rest;
	const end = nl.search(/\n---\s*(?:\n|$)/);
	if (end < 0) return null;
	const fm = nl.slice(0, end);
	const line = fm.split("\n").find((l) => /^status:\s*/.test(l));
	if (!line) return null;
	const raw = line.replace(/^status:\s*/, "").trim().replace(/^['"]|['"]$/g, "");
	if (!raw) return null;
	if (raw.includes("進行中") && !firstTerminalWord(raw)) return "進行中";
	return firstTerminalWord(raw) ?? raw;
}

export type JournalWatchFacts = {
	journalStatus: JournalStatus;
	statusWord: string | null;
	journalMergePending: boolean;
	journalStale: boolean;
	journalNoMerge: boolean;
	journalPresent: boolean;
};

/**
 * watch 用の終端判定。frontmatter `status:` が終端ならそれを正（wiki）。
 * ファイル全体が終端でないときだけ当該レーン節に落とす（共有 journal）。
 */
export function journalWatchFacts(
	body: string,
	marker: string,
	opts?: { worktree?: string | null; branch?: string | null },
): JournalWatchFacts {
	const fm = journalFrontmatterStatusWord(body);
	const fmTerm = fm ? firstTerminalWord(fm) : null;
	if (fmTerm) {
		return {
			journalStatus: "terminal",
			statusWord: fmTerm,
			journalMergePending: JOURNAL_MERGE_REQUIRING_WORDS.some((w) => w === fmTerm),
			journalStale: false,
			journalNoMerge: JOURNAL_NO_MERGE_WORDS.some((w) => w === fmTerm),
			journalPresent: true,
		};
	}
	const m = (marker ?? "").trim();
	if (!m) {
		return {
			journalStatus: fm === "進行中" ? "in_progress" : "unknown",
			statusWord: fm,
			journalMergePending: false,
			journalStale: false,
			journalNoMerge: false,
			journalPresent: true,
		};
	}
	const status = journalSectionStatus(body, m, opts);
	return {
		journalStatus: status,
		statusWord: journalSectionStatusWord(body, m, opts),
		journalMergePending: journalSectionMergePending(body, m, opts),
		journalStale: journalSectionStale(body, m, opts),
		journalNoMerge: journalSectionNoMerge(body, m, opts),
		journalPresent: status === "terminal" || status === "in_progress",
	};
}

/**
 * P0.b: 当該 label の節が全て watch の worktree/branch と不一致（旧波の残骸）か。
 * watch メタ無しは検証不能 → false（旧挙動を維持）。
 */
export function journalSectionStale(
	body: string,
	marker: string,
	opts?: { worktree?: string | null; branch?: string | null },
): boolean {
	const m = (marker ?? "").trim();
	if (!m) return false;
	const wt = (opts?.worktree ?? "").trim();
	const br = (opts?.branch ?? "").trim();
	if (!wt && !br) return false;
	return selectJournalSection(body, m, wt, br).stale;
}

/** 当該 label 節（watch 一致節）が merge 成果前提の終端語彙（merge待ち）を含むか。 */
export function journalSectionMergePending(
	body: string,
	marker: string,
	opts?: { worktree?: string | null; branch?: string | null },
): boolean {
	const m = (marker ?? "").trim();
	if (!m) return false;
	const { section } = selectJournalSection(body, m, opts?.worktree, opts?.branch);
	if (!section) return false;
	return JOURNAL_MERGE_REQUIRING_WORDS.some((w) => section.includes(w));
}

/**
 * P0.c: 当該 label 節の status_word（lane-journal-section.sh と同一語彙・同一優先順）。
 * 見出し終端語彙 > 本文終端語彙。見出し「進行中」は本文の部分 PASS に釣られない。
 */
export function journalSectionStatusWord(
	body: string,
	marker: string,
	opts?: { worktree?: string | null; branch?: string | null },
): string | null {
	const m = (marker ?? "").trim();
	if (!m) return null;
	const { section } = selectJournalSection(body, m, opts?.worktree, opts?.branch);
	if (!section) return null;
	const heading = section.replace(/^\n+/, "").split(/\n/, 1)[0];
	const headingTerm = firstTerminalWord(heading);
	if (heading.includes("進行中") && !headingTerm) return "進行中";
	if (headingTerm) return headingTerm;
	return firstTerminalWord(section);
}

/** P0.c: 当該 label 節が merge 不要系語彙（merge不要/差分なし/…）を含むか。 */
export function journalSectionNoMerge(
	body: string,
	marker: string,
	opts?: { worktree?: string | null; branch?: string | null },
): boolean {
	const m = (marker ?? "").trim();
	if (!m) return false;
	const { section } = selectJournalSection(body, m, opts?.worktree, opts?.branch);
	if (!section) return false;
	return JOURNAL_NO_MERGE_WORDS.some((w) => textHasWord(section, w));
}

/**
 * P5: 見出し欠落（missing）時の merge待ち 判定は全文スキャンしない。
 * label / branch を含む行の近傍（±2 行）に merge待ち 系語彙がある行だけ数える。
 * 共有 journal の隣レーンの merge待ち に釣られない。
 */
export function journalBodyMergePendingNear(
	body: string,
	marker: string,
	branch?: string | null,
): boolean {
	const m = (marker ?? "").trim();
	if (!m) return false;
	const br = (branch ?? "").trim();
	const lines = body.split("\n");
	const hasMergeWait = (line: string) =>
		JOURNAL_MERGE_REQUIRING_WORDS.some((w) => textHasWord(line, w));
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.includes(m) && !(br && line.includes(br))) continue;
		for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
			if (hasMergeWait(lines[j])) return true;
		}
	}
	return false;
}

/**
 * Mechanical triage. Cheap LLM is only asked when needsCheapReview.
 * Parent wakes only for signal completion|anomaly.
 */
export function triageEvent(input: {
	kind: WatchKind;
	reason: LaneEventReason;
	to: LaneStatus;
	health: HealthFacts;
}): TriageResult {
	const facts = factsToStrings(input.health);
	const { kind, reason, to } = input;
	const { journalPresent, ahead } = input.health;

	if (reason === "gone" || to === "gone") {
		return {
			signal: "anomaly",
			verdict: "gone",
			needsCheapReview: false,
			facts,
			summary: "agent gone",
		};
	}
	if (reason === "blocked" || to === "blocked") {
		return {
			signal: "anomaly",
			verdict: "blocked",
			needsCheapReview: false,
			facts,
			summary: "agent blocked",
		};
	}
	if (reason === "wait_error") {
		return {
			signal: "anomaly",
			verdict: "wait_error",
			needsCheapReview: false,
			facts,
			summary: "wait error",
		};
	}

	if (reason === "settled" || to === "idle" || to === "done") {
		// 安委譲の settled は常に親が回収（completion）。介入中（mux_intervene force の
		// execute 中）の一時 idle は index.ts 側が isIntervening で抑止する。
		if (kind === "cheap") {
			return {
				signal: "completion",
				verdict: "completion",
				needsCheapReview: false,
				facts,
				summary: "cheap settled — recover pane",
			};
		}
		// 003 P0: completion は「当該 label 節あり AND 終端語彙」の AND。
		// journalStatus が無い旧呼び出しは journalPresent から導出（true→unknown / false→missing）。
		// dirty は完了判定に使わない（LANE.md のみの dirty はノイズ）。
		const jStatus =
			input.health.journalStatus ??
			(journalPresent === true ? "unknown" : journalPresent === false ? "missing" : "unknown");

		if (jStatus === "terminal") {
			// P0.b: 旧波終端節（watch worktree/branch 不一致）は completion にしない
			if (input.health.journalStale === true) {
				return {
					signal: "anomaly",
					verdict: "stale_section",
					needsCheapReview: false,
					facts,
					summary:
						"lane settled terminal but journal 節は旧波（worktree/branch 不一致）— completion ではない。今波の節を書け",
				};
			}
			if (kind === "peer") {
				const word = (input.health.statusWord ?? "").trim();
				// 依頼 journal にレーン語彙（merge待ち/merged）は終端ではない
				if (isPeerLaneOnlyStatus(word) || input.health.journalMergePending === true) {
					return {
						signal: "waiting",
						verdict: "in_progress_settled",
						needsCheapReview: false,
						facts,
						summary: "peer journal は merge待ち/merged（レーン語彙）— 依頼の終端ではない",
					};
				}
				return {
					signal: "completion",
					verdict: "completion",
					needsCheapReview: false,
					facts,
					summary: "peer settled — 依頼 journal 終端（対岸作業完了）",
				};
			}
			// merge待ち なのに ahead=0 → 矛盾。安易に completion しない（cheap review へ）。lane 専用。
			if (ahead != null && ahead === 0 && input.health.journalMergePending === true) {
				return {
					signal: "anomaly",
					verdict: "needs_review",
					needsCheapReview: true,
					facts,
					summary: "lane settled terminal(merge待ち) but ahead=0 — merge 成果を確認",
				};
			}
			return {
				signal: "completion",
				verdict: "completion",
				needsCheapReview: false,
				facts,
				summary: ahead != null && ahead > 0 ? "lane settled terminal with commits" : "lane settled terminal journal ok",
			};
		}
		// 非終端 idle/done はすぐ親へ出さない（5 分様子見は index）。nudge しない。
		const waiting = (verdict: TriageVerdict, summary: string): TriageResult => ({
			signal: "waiting",
			verdict,
			needsCheapReview: false,
			facts,
			summary,
		});
		if (to === "idle") {
			return waiting("idle_wait", "lane idle — 5分様子見。journal 非終端。親へ出さない");
		}
		if (jStatus === "in_progress") {
			return waiting(
				"in_progress_settled",
				"lane done but journal 節は進行中のみ — 5分様子見。親へ出さない",
			);
		}
		if (jStatus === "missing") {
			if (ahead != null && ahead >= 1 && input.health.journalBodyMergePending === true) {
				return waiting(
					"merge_pending_no_heading",
					"lane done, 見出し欠落だが本文に merge待ち・ahead≥1 — 5分様子見。見出しを立て直す",
				);
			}
			return waiting("premature_settled", "lane done without journal section — 5分様子見。親へ出さない");
		}
		return waiting("needs_review", "lane done journal unknown — 5分様子見。親へ出さない");
	}

	// safety / periodic while working: default healthy; cheap model may flag anomaly
	if (reason === "safety" || reason === "periodic") {
		return {
			signal: "healthy",
			verdict: "needs_review",
			needsCheapReview: true,
			facts,
			summary: reason === "periodic" ? "periodic health check" : "still working safety ping",
		};
	}

	return {
		signal: "healthy",
		verdict: "healthy",
		needsCheapReview: false,
		facts,
		summary: "no action",
	};
}

/**
 * P3: レーン tab 配下の子 agent のうち working が残っているか。
 * working のみ抑止対象。unknown/blocked/gone/idle/done は抑止しない（fail-open）。
 */
export function anyChildWorking(children: readonly { status?: string | null }[]): boolean {
	return children.some((c) => normalizeStatus(c.status) === "working");
}

/**
 * P3/P5: 孫（cheap explore/executor）が working の間、lane settled の completion / anomaly / waiting も
 * deferred で抑止する（親を起こさない）。拡張が孫の終了を確認して 1 回だけ再トリアージする。
 * 機械判定（needsCheapReview=false）。grandchildrenWorking=false / 非 settled 評価は変えない。
 */
export function deferForGrandchildren(triage: TriageResult, grandchildrenWorking: boolean): TriageResult {
	if (!grandchildrenWorking) return triage;
	if (triage.signal !== "completion" && triage.signal !== "anomaly" && triage.signal !== "waiting") return triage;
	return {
		signal: "deferred",
		verdict: triage.signal === "completion" ? "children_alive" : triage.verdict,
		needsCheapReview: false,
		facts: triage.facts,
		summary:
			triage.signal === "completion"
				? "lane settled but 孫（cheap explore/executor）が working — 親を起こさない。拡張内で完了を待つ"
				: "lane settled but 孫が working — 親へ出さない。孫終了後に再トリアージ",
	};
}

/** 様子見タイマー発火時、まだ非終端 settled なら親へ出す。 */
export function stillSettledGraceElapsed(
	armedAt: number | null,
	now: number,
	graceSec: number = STILL_SETTLED_GRACE_SEC,
): boolean {
	if (armedAt == null) return false;
	return now - armedAt >= graceSec * 1000;
}

/**
 * still_settled_grace（5 分様子見）発火時の待ち後処理。
 * kind=peer（対岸監督）は依頼 journal 終端まで journal 再読で待つだけなので PEER_EVENT anomaly にしない
 * （完了条件）。lane/cheap は従来どおり 5 分後に 1 回 anomaly へ畳む。
 * returns: waiting non-peer → anomaly triage。peer → null（anomaly にしない）。
 */
export function graceElapsedFollowup(kind: WatchKind, waiting: TriageResult): TriageResult | null {
	if (kind === "peer") return null;
	if (waiting.signal !== "waiting") return waiting;
	return {
		signal: "anomaly",
		verdict: waiting.verdict,
		needsCheapReview: false,
		facts: waiting.facts,
		summary: `5分様子見後も非終端 settled（${waiting.verdict}）— 親へ anomaly`,
	};
}

/** Apply cheap-model JSON verdict onto a triage that asked for review. */
export function applyCheapVerdict(
	base: TriageResult,
	cheap: { verdict: "ok" | "anomaly"; reason?: string },
): TriageResult {
	if (cheap.verdict === "ok") {
		// settled + needs_review that cheap says ok → treat as completion for lane
		if (base.verdict === "needs_review" && base.summary.includes("settled")) {
			return {
				signal: "completion",
				verdict: "completion",
				needsCheapReview: false,
				facts: base.facts,
				summary: cheap.reason?.slice(0, 160) || "cheap ok — completion",
			};
		}
		return {
			signal: "healthy",
			verdict: "healthy",
			needsCheapReview: false,
			facts: base.facts,
			summary: cheap.reason?.slice(0, 160) || "cheap ok",
		};
	}
	return {
		signal: "anomaly",
		verdict: base.verdict === "needs_review" ? "stuck" : base.verdict,
		needsCheapReview: false,
		facts: base.facts,
		summary: cheap.reason?.slice(0, 160) || "cheap anomaly",
	};
}

/** Parse cheap model stdout. Tolerant of markdown fences. */
export function parseCheapVerdict(text: string): { verdict: "ok" | "anomaly"; reason?: string } | null {
	const raw = text.trim();
	if (!raw) return null;
	const fenced = raw.match(/\{[\s\S]*\}/);
	const jsonText = fenced ? fenced[0] : raw;
	try {
		const obj = JSON.parse(jsonText) as { verdict?: string; reason?: string };
		const v = (obj.verdict ?? "").trim().toLowerCase();
		if (v === "ok" || v === "healthy" || v === "fine" || v === "continue") {
			return { verdict: "ok", reason: obj.reason };
		}
		if (v === "anomaly" || v === "bad" || v === "stuck" || v === "error" || v === "alert") {
			return { verdict: "anomaly", reason: obj.reason };
		}
	} catch {
		/* fall through */
	}
	const lower = raw.toLowerCase();
	if (/\b(anomaly|stuck|blocked|premature|loop)\b/.test(lower) && !/\bok\b/.test(lower)) {
		return { verdict: "anomaly", reason: raw.slice(0, 160) };
	}
	if (/\b(ok|healthy|fine|continue|normal)\b/.test(lower)) {
		return { verdict: "ok", reason: raw.slice(0, 160) };
	}
	return null;
}

export function formatParentEvent(e: {
	kind?: WatchKind | string | null;
	signal: ParentSignal;
	agent: string;
	from: LaneStatus | string;
	to: LaneStatus | string;
	reason: LaneEventReason | string;
	verdict: string;
	label?: string;
	tabId?: string;
	worktree?: string;
	branch?: string;
	facts?: string[];
	summary?: string;
	detail?: string;
	next?: PeerNext;
}): string {
	const kind = resolveWatchKind({ kind: e.kind, label: e.label });
	const prefix = kind === "cheap" ? "CHEAP_EVENT" : kind === "peer" ? "PEER_EVENT" : "LANE_EVENT";
	const parts = [
		`${prefix}: kind=${kind}`,
		`signal=${e.signal}`,
		`agent=${e.agent}`,
		`from=${e.from}`,
		`to=${e.to}`,
		`reason=${e.reason}`,
		`verdict=${e.verdict}`,
	];
	if (e.label) parts.push(`label=${e.label.replaceAll(/\s+/g, " ").slice(0, 80)}`);
	if (e.tabId) parts.push(`tab=${e.tabId}`);
	if (e.worktree) parts.push(`worktree=${e.worktree}`);
	if (e.branch) parts.push(`branch=${e.branch}`);
	if (e.facts && e.facts.length) {
		// peer（対岸）の親へは merge/撤収 系の語句を facts でも出さない（対岸の merge/撤収は対岸監督側）
		const facts = kind === "peer" ? e.facts.filter((f) => !/(merge|撤収)/.test(f)) : e.facts;
		if (facts.length) parts.push(`facts=${facts.join(";")}`);
	}
	if (e.summary) parts.push(`summary=${e.summary.replaceAll(/\s+/g, " ").slice(0, 160)}`);
	if (e.detail) parts.push(`detail=${e.detail.replaceAll(/\s+/g, " ").slice(0, 160)}`);
	if (e.signal === "completion") {
		if (kind === "cheap") {
			parts.push("親: 閉じる判定は delegate-execute。通っても枠を閉じる前に review を read しレビュー節。未実施のまま完了を言うな。transcript 深読みするな。");
		} else if (kind === "peer") {
			const word = (e.facts ?? []).find((f) => f.startsWith("status_word="))?.slice("status_word=".length) ?? null;
			const next = e.next ?? peerNextForStatusWord(word);
			parts.push(`next=${next}`);
			parts.push(peerParentHint(next));
		} else {
			parts.push("親: merge/撤収判断のみ。status/git は facts を使え。transcript 深読みするな。");
		}
	} else {
		parts.push("親: 異常対応のみ（短い intervene 1 文 or 方針）。healthy 点検は extension 済み。深読みするな。");
	}
	return parts.join(" ");
}

/** @deprecated use formatParentEvent. */
export function formatLaneEvent(e: {
	kind?: WatchKind | string | null;
	agent: string;
	from: LaneStatus | string;
	to: LaneStatus | string;
	reason: LaneEventReason | string;
	label?: string;
	tabId?: string;
	worktree?: string;
	detail?: string;
	signal?: ParentSignal;
	verdict?: string;
	facts?: string[];
	summary?: string;
	branch?: string;
}): string {
	const reason = String(e.reason);
	const signal: ParentSignal =
		e.signal ??
		(reason === "settled" || reason === "blocked" || reason === "gone" || reason === "wait_error"
			? reason === "settled"
				? "completion"
				: "anomaly"
			: "anomaly");
	return formatParentEvent({
		kind: e.kind,
		signal,
		agent: e.agent,
		from: e.from,
		to: e.to,
		reason: e.reason,
		verdict: e.verdict ?? reason,
		label: e.label,
		tabId: e.tabId,
		worktree: e.worktree,
		branch: e.branch,
		facts: e.facts,
		summary: e.summary,
		detail: e.detail,
	});
}

export function extractAgentStatus(data: unknown): string | null {
	const walk = (d: unknown): string | null => {
		if (Array.isArray(d)) {
			for (const x of d) {
				const hit = walk(x);
				if (hit) return hit;
			}
			return null;
		}
		if (d && typeof d === "object") {
			const rec = d as Record<string, unknown>;
			if (typeof rec.agent_status === "string") return rec.agent_status;
			for (const v of Object.values(rec)) {
				const hit = walk(v);
				if (hit) return hit;
			}
		}
		return null;
	};
	return walk(data);
}

export const CHEAP_CHECK_SYSTEM = [
	"You are a lane/cheap-agent health checker for a coding supervisor.",
	"Reply with ONLY one JSON object: {\"verdict\":\"ok\"|\"anomaly\",\"reason\":\"short\"}.",
	"ok = still fine or normal progress; parent must NOT wake.",
	"anomaly = stuck loop, premature done, blocked without progress, crashed, needs human/parent.",
	"Do not narrate. No markdown.",
].join(" ");

export function buildCheapCheckPrompt(input: {
	kind: WatchKind;
	agent: string;
	reason: string;
	label?: string;
	facts: string[];
	logTail?: string;
}): string {
	const lines = [
		`kind=${input.kind}`,
		`agent=${input.agent}`,
		`reason=${input.reason}`,
	];
	if (input.label) lines.push(`label=${input.label}`);
	lines.push(`facts: ${input.facts.join(" ")}`);
	if (input.logTail) {
		lines.push("log_tail:");
		lines.push(input.logTail.slice(0, 2500));
	}
	lines.push('JSON only: {"verdict":"ok"|"anomaly","reason":"..."}');
	return lines.join("\n");
}
