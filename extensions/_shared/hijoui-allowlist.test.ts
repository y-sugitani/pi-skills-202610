import { describe, expect, test } from "bun:test";
import { ALWAYS_ALLOW_TOOLS, DELEGATE_BASH_RE, DELEGATION_READ_PATH_RE } from "./hijoui-allowlist.ts";

// 委譲を「起動する・待つ・閉じる」ための制御系は宣言なしで通す必要がある
describe("hijoui-allowlist: 宣言不要ツール", () => {
	test("Herdr 外の async 委譲を閉じるまでに使う待ち・連絡系", () => {
		for (const tool of ["subagent", "subagent_wait", "bg_wait", "contact_supervisor", "intercom"]) {
			expect(ALWAYS_ALLOW_TOOLS.has(tool), tool).toBe(true);
		}
	});

	test("レーン監督・mux・タイマー", () => {
		for (const tool of [
			"spawn_cheap",
			"subagent_supervisor",
			"lane_watch",
			"lane_unwatch",
			"lane_watch_status",
			"peer_supervisor",
			"herdr_layout",
			"herdr_pane",
			"herdr_agent",
			"mux_intervene",
			"mux_close",
			"timer_start",
			"timer_stop",
			"timer_status",
		]) {
			expect(ALWAYS_ALLOW_TOOLS.has(tool), tool).toBe(true);
		}
	});

	test("作業ツールは含めない（ガードの意味が消える）", () => {
		for (const tool of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
			expect(ALWAYS_ALLOW_TOOLS.has(tool), tool).toBe(false);
		}
	});
});

describe("hijoui-allowlist: パス・bash 許可", () => {
	test("委譲用 skill と AGENTS.md だけ read 可", () => {
		expect(DELEGATION_READ_PATH_RE.test("delegate-execute/SKILL.md")).toBe(true);
		expect(DELEGATION_READ_PATH_RE.test("/Users/x/.pi/agent/skills/mux-pi/SKILL.md")).toBe(true);
		expect(DELEGATION_READ_PATH_RE.test("lane-control/SKILL.md")).toBe(true);
		expect(DELEGATION_READ_PATH_RE.test("AGENTS.md")).toBe(true);
		expect(DELEGATION_READ_PATH_RE.test("src/index.ts")).toBe(false);
		expect(DELEGATION_READ_PATH_RE.test("skills/wiki/SKILL.md")).toBe(false);
	});

	test("bash は委譲起動コマンドだけ通す", () => {
		expect(DELEGATE_BASH_RE.test("bash skills/mux-pi/scripts/spawn-agent.sh exec")).toBe(true);
		expect(DELEGATE_BASH_RE.test("herdr agent start --tab t1")).toBe(true);
		expect(DELEGATE_BASH_RE.test("bun test extensions")).toBe(false);
		expect(DELEGATE_BASH_RE.test("rg foo .")).toBe(false);
	});
});
