import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteCheapLease, tabHasWorkingLease, writeCheapLease } from "./health.ts";

test("lease: working + TTL 内だけ busy / 別 tab・非 working・TTL 切れ・delete は busy にしない", () => {
	const root = mkdtempSync(join(tmpdir(), "lane-lease-"));
	try {
		writeCheapLease({ tabId: "t1", agent: "exec1", status: "working", ttlSec: 120 }, root);
		expect(tabHasWorkingLease("t1", { root })).toBe(true);
		// 別 tab には効かない
		expect(tabHasWorkingLease("t2", { root })).toBe(false);
		// TTL 切れ → busy にしない（クラッシュで永久ピン止めしない）
		expect(tabHasWorkingLease("t1", { root, now: Date.now() + 121_000 })).toBe(false);
		// 非 working で上書き → busy にしない
		writeCheapLease({ tabId: "t1", agent: "exec1", status: "idle", ttlSec: 120 }, root);
		expect(tabHasWorkingLease("t1", { root })).toBe(false);
		// delete → busy にしない
		writeCheapLease({ tabId: "t1", agent: "exec1", status: "working", ttlSec: 120 }, root);
		deleteCheapLease("exec1", root);
		expect(tabHasWorkingLease("t1", { root })).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("lease: 同一 tab の複数 cheap はどれかが working なら busy（OR）", () => {
	const root = mkdtempSync(join(tmpdir(), "lane-lease-"));
	try {
		writeCheapLease({ tabId: "t1", agent: "explore1", status: "idle", ttlSec: 120 }, root);
		expect(tabHasWorkingLease("t1", { root })).toBe(false);
		writeCheapLease({ tabId: "t1", agent: "exec2", status: "working", ttlSec: 120 }, root);
		expect(tabHasWorkingLease("t1", { root })).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("lease: tab 無しは書かない / 壊れた JSON は無視", () => {
	const root = mkdtempSync(join(tmpdir(), "lane-lease-"));
	try {
		writeCheapLease({ agent: "exec1", status: "working", ttlSec: 120 }, root);
		expect(tabHasWorkingLease("t1", { root })).toBe(false);
		writeCheapLease({ tabId: "t1", agent: "bad name!", status: "working", ttlSec: 120 }, root);
		expect(tabHasWorkingLease("t1", { root })).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
