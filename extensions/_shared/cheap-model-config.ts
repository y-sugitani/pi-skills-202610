/**
 * cheap-model.json（安いサブの provider/model/thinking）の読み書き。
 *
 * 置き場所は pi の agent dir（PI_CODING_AGENT_DIR → ~/.pi/agent）。
 * lane-supervisor の health.ts からも読むため、テストでも解決できるよう
 * pi-coding-agent を import しない（同じ規則をここで解決する）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** pi cli の VALID_THINKING_LEVELS と同じ並び */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type CheapModelConfig = { provider: string; model: string; thinking?: ThinkingLevel };

export function isValidThinkingLevel(v: unknown): v is ThinkingLevel {
	return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

/** pi の getAgentDir と同じ解決（PI_CODING_AGENT_DIR は ~ 展開する）。 */
export function agentDir(): string {
	const raw = process.env.PI_CODING_AGENT_DIR?.trim();
	if (raw) {
		if (raw === "~") return homedir();
		if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
		return isAbsolute(raw) ? raw : join(process.cwd(), raw);
	}
	return join(homedir(), ".pi", "agent");
}

export function cheapModelConfigPath(): string {
	return join(agentDir(), "cheap-model.json");
}

/** 未設定・壊れている → null（呼び出し側が既定へ落ちる）。 */
export function readCheapModelConfig(): CheapModelConfig | null {
	try {
		const cfg = JSON.parse(readFileSync(cheapModelConfigPath(), "utf8"));
		if (
			cfg &&
			typeof cfg.provider === "string" &&
			cfg.provider &&
			typeof cfg.model === "string" &&
			cfg.model
		) {
			const out: CheapModelConfig = { provider: cfg.provider, model: cfg.model };
			// 壊れた thinking は無視して Pi 既定に任せる（旧 JSON・不正値でも壊さない）
			if (isValidThinkingLevel(cfg.thinking)) out.thinking = cfg.thinking;
			return out;
		}
	} catch {
		/* 無い・壊れている → 未設定 */
	}
	return null;
}

/** pi の --model に渡す値。thinking があるときだけ provider/model:thinking。 */
export function cheapModelOverride(): string | null {
	const cfg = readCheapModelConfig();
	if (!cfg) return null;
	return cfg.thinking ? `${cfg.provider}/${cfg.model}:${cfg.thinking}` : `${cfg.provider}/${cfg.model}`;
}

/** pi 既定（--model を渡さない）を表す表示用の値 */
export const PI_DEFAULT_MODEL_LABEL = "(pi の既定モデル)";

/**
 * lane-supervisor の拡張内点検が使うモデル。
 * LANE_CHEAP_MODEL → cheap-model.json → pi 既定（model 無し）。
 */
export function resolveLaneCheapModel(): { model: string | null; id: string } {
	const fromEnv = process.env.LANE_CHEAP_MODEL?.trim();
	if (fromEnv) return { model: fromEnv, id: fromEnv };
	const override = cheapModelOverride();
	if (override) return { model: override, id: override };
	return { model: null, id: PI_DEFAULT_MODEL_LABEL };
}
