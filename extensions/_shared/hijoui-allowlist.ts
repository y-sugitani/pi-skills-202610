/**
 * hijoui-guard の許可リスト（パッケージ内でここ 1 か所に集約する）。
 *
 * ツール名・宣言 code・宣言なしで読める委譲手順の path をここだけ直せばよい。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "./cheap-model-config.ts";

/** 非委譲宣言の code */
export const VALID_CODES = [
	"user-forbid",
	"decision-only",
	"tiny-patch",
	"meta",
	"skill",
	"design-write",
] as const;
export type HijouiCode = (typeof VALID_CODES)[number];

export const CODE_RE = /非委譲\s*[:：]\s*(user-forbid|decision-only|tiny-patch|meta|skill|design-write)\b/;

/** 宣言なしで使えるツール（委譲起動・監督・通信） */
export const ALWAYS_ALLOW_TOOLS: ReadonlySet<string> = new Set([
	// タイマー（このパッケージの session-timer）
	"timer_start",
	"timer_stop",
	"timer_status",
	// レーン監督（このパッケージの lane-supervisor）
	"lane_watch",
	"lane_unwatch",
	"lane_watch_status",
	"peer_supervisor",
	// 委譲起動（このパッケージの spawn-cheap / 外部の subagent 系）
	"spawn_cheap",
	"subagent",
	"subagent_wait",
	"subagent_supervisor",
	// 完了待ちと親への連絡。Herdr 外の async 委譲はこれで待つので塞ぐと委譲が閉じない
	"bg_wait",
	"contact_supervisor",
	"intercom",
	// mux 操作（Herdr 連携。mux_intervene / mux_close はこのパッケージ）
	"herdr_layout",
	"herdr_pane",
	"herdr_agent",
	"mux_intervene",
	"mux_close",
]);

/** 委譲手順を読むためだけの path 許可（これ以外の read は宣言が要る） */
export const DELEGATION_READ_PATH_RE =
	/(^|\/)(delegate-execute|mux-pi|lane-control)(\/|$)|(^|\/)(AGENTS\.md|APPEND_SYSTEM\.md)$/;

/** bash が委譲起動そのものか */
export const DELEGATE_BASH_RE =
	/spawn-agent\.sh|mux-pi|herdr\s+agent\s+start|\bsubagent\b.*explore|\bsubagent\b.*executor|runs\.run\s*\(|workflowScript/;

const OFF_VALUES = new Set(["0", "off", "false", "disable", "disabled", "no"]);

const CONFIG_FILENAME = "hijoui-guard.json";

let configCache: boolean | null = null;

/**
 * ガードの無効化。次のどちらでも off:
 * - 環境変数 PI_HIJOUIGUARD=off / 0 / false / disable
 * - agent dir の hijoui-guard.json が { "enabled": false }
 * 既定は有効（ファイル無し・壊れた JSON は有効扱い）。
 */
export function isHijouiGuardDisabled(): boolean {
	if (OFF_VALUES.has((process.env.PI_HIJOUIGUARD ?? "").trim().toLowerCase())) return true;
	if (configCache !== null) return configCache;
	let disabled = false;
	const path = join(agentDir(), CONFIG_FILENAME);
	try {
		if (existsSync(path)) {
			const cfg = JSON.parse(readFileSync(path, "utf8"));
			disabled = cfg?.enabled === false;
		}
	} catch {
		/* 壊れた JSON は既定（有効）に倒す */
	}
	configCache = disabled;
	return disabled;
}

/** セッションをまたいで設定を読み直したいとき用（テスト・/reload 相当）。 */
export function resetHijouiGuardConfigCache(): void {
	configCache = null;
}
