/**
 * パッケージ内リソースの解決。
 *
 * pi は拡張をパッケージ複製先から読むので、ホーム配下の install 済みスキル
 * (~/.pi/agent/skills/... 等) を探すと読者の環境で必ず外れる。
 * ここは「このファイルからの相対位置」だけで解決する。
 * このディレクトリは index.ts を持たないため拡張としてロードされない。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** <pkg>/extensions/_shared → <pkg> */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function packageRoot(): string {
	return PACKAGE_ROOT;
}

/** mux-pi のスクリプト 1 本の絶対パス（無ければ null）。 */
export function muxScript(name: string): string | null {
	const path = join(PACKAGE_ROOT, "skills", "mux-pi", "scripts", name);
	return existsSync(path) ? path : null;
}

/**
 * /start-lane が流すプロンプト（無ければ null）。
 * pi.prompts（`/start-lane` コマンド）と衝突しないよう、パッケージの prompts/ ではなく
 * skill 側の資材として置く。
 */
export function startLanePromptPath(): string | null {
	const path = join(PACKAGE_ROOT, "skills", "lane-control", "prompts", "start-lane.md");
	return existsSync(path) ? path : null;
}
