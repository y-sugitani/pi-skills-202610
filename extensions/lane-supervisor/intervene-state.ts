/**
 * intervene-state — mux_intervene force=true の「介入中」を同 process メモリで管理する。
 * 介入中（execute 入場〜return）の cheap settled を CHEAP_EVENT completion にしないためのフラグ。
 * /tmp 等の外部状態は使わない（介入は親 process 自身が行い、抑止が必要な lane_watch も
 * 同じ process が持つ。観測: 同じ親 process が lane_watch も持つ）。
 *
 * extensions/ 直下に置かない（Pi が factory 必須の拡張として読む）。
 */
const intervening = new Set<string>();

/** 介入開始（mux_intervene force=true の execute 入場）。 */
export function markIntervening(agent: string): void {
	intervening.add(agent);
}

/** 介入終了（execute return。成功でも失敗でも）。 */
export function clearIntervening(agent: string): void {
	intervening.delete(agent);
}

/** 介入中か。 */
export function isIntervening(agent: string): boolean {
	return intervening.has(agent);
}
