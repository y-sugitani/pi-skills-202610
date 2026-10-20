/**
 * Pi 既定の active tools は read/bash/edit/write のみ。
 * grep/find/ls（中身は rg / fd、cwd・gitignore 付き）を常時足す。
 * これがないと system prompt が「bash で ls/rg/find しろ」になりホーム横断 walk に落ちる。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SEARCH_TOOLS = ["grep", "find", "ls"] as const;

function enableSearchTools(pi: ExtensionAPI) {
	const active = pi.getActiveTools();
	const missing = SEARCH_TOOLS.filter((name) => !active.includes(name));
	if (missing.length === 0) return;
	pi.setActiveTools([...new Set([...active, ...SEARCH_TOOLS])]);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => enableSearchTools(pi));
}
