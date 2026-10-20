/**
 * cheap-model — 安いサブエージェント（explore / executor）のモデル選択。
 *
 * /cheap-model で provider/model を選び、続いて think レベルを選んで
 * ~/.pi/agent/cheap-model.json に書く（thinking は「指定しない」も可）。
 * spawn_cheap がこのファイルを読んで --model provider/model[:thinking] を渡す
 * （ファイルが無い・壊れているときは agent 定義の model: に落ちる）。
 * 親セッションのモデルは変更しない（pi.setModel は呼ばない）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { writeFileSync } from "node:fs";
import {
	agentDir,
	type CheapModelConfig,
	cheapModelConfigPath,
	isValidThinkingLevel,
	readCheapModelConfig,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "./_shared/cheap-model-config.ts";

export type { CheapModelConfig };

/**
 * 候補プロバイダ。既定はレジストリに居るプロバイダ全部。
 * PI_CHEAP_PROVIDERS="provider-a,provider-b" で絞れる（安いプロバイダだけ出したい場合）。
 */
function cheapProviders(available: { provider: string }[]): Set<string> {
	const raw = process.env.PI_CHEAP_PROVIDERS?.trim();
	if (raw) return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
	return new Set(available.map((m) => m.provider));
}

export function readCurrent(): CheapModelConfig | null {
	return readCheapModelConfig();
}

export function saveCheapModel(cfg: CheapModelConfig): void {
	const out: CheapModelConfig = { provider: cfg.provider, model: cfg.model };
	if (isValidThinkingLevel(cfg.thinking)) out.thinking = cfg.thinking;
	writeFileSync(cheapModelConfigPath(), `${JSON.stringify(out, null, 2)}\n`, "utf8");
}

/**
 * 選択中モデルで使える thinking レベル。pi-ai の getSupportedThinkingLevels と同じ判定
 * （reasoning=false → off のみ。xhigh/max は map に明示があるときだけ。null は非扱い）。
 * 判定不能な形の map は絞らず全レベルを出して Pi 側クランプに任せる。
 */
function supportedThinkingLevels(model: {
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}): string[] {
	if (!model.reasoning) return ["off"];
	const map = model.thinkingLevelMap;
	if (!map || typeof map !== "object") return [...THINKING_LEVELS];
	return THINKING_LEVELS.filter((level) => {
		const mapped = map[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/**
 * SelectList を出して 1 値を選ばせる。esc → null。
 * 入力中の文字で候補を絞り込める：↑↓/Enter/Esc はナビゲーション、それ以外は検索入力
 * （pi 本体の SelectSubmenu / ModelSelector と同じパターン。0 件なら No matching 表示）。
 */
function pickFromList(ctx: ExtensionContext, title: string, items: SelectItem[]): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title))));

		const selectTheme = {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		};
		const buildSelectList = (options: SelectItem[]) => {
			const list = new SelectList(options, Math.min(options.length, 10), selectTheme);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			return list;
		};

		// 検索入力。Enter はナビとしてリストに委ねる（空で確定させない）
		let selectList = buildSelectList(items);
		const searchInput = new Input();
		searchInput.onSubmit = () => selectList.handleInput("\r");
		container.addChild(searchInput);
		const listIndex = container.children.length;
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "type to filter • ↑↓ navigate • enter select • esc cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		// 入力文字で候補を絞り込み直す（fuzzy。pi 本体の SelectSubmenu と同じ）
		const applyFilter = (query: string) => {
			const filtered = query
				? fuzzyFilter(items, query, (item) => `${item.label} ${item.description ?? ""}`)
				: items;
			const newList = buildSelectList(filtered);
			container.children[listIndex] = newList;
			selectList = newList;
		};

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				const isNav =
					keybindings.matches(data, "tui.select.up") ||
					keybindings.matches(data, "tui.select.down") ||
					keybindings.matches(data, "tui.select.confirm") ||
					keybindings.matches(data, "tui.select.cancel");
				if (isNav) {
					selectList.handleInput(data);
				} else {
					searchInput.handleInput(data);
					applyFilter(searchInput.getValue());
				}
				tui.requestRender();
			},
		};
	});
}

export default function cheapModel(pi: ExtensionAPI) {
	pi.registerCommand("cheap-model", {
		description:
			`安いサブエージェント（explore / executor）のモデルと thinking を選択して ${cheapModelConfigPath()} に保存`,
		handler: async (_args, ctx: ExtensionContext) => {
			const current = readCurrent();
			const currentKey = current ? `${current.provider}/${current.model}` : null;

			const all = ctx.modelRegistry.getAvailable();
			const providers = cheapProviders(all);
			const available = all
				.filter((m) => providers.has(m.provider))
				.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));

			const items: SelectItem[] = available.map((m) => {
				const key = `${m.provider}/${m.id}`;
				return {
					value: key,
					label: key,
					description: currentKey === key ? "現在の設定" : undefined,
				};
			});

			if (items.length === 0) {
				ctx.ui.notify(
					`cheap-model: 候補モデルが無い（${[...providers].join(" / ") || "プロバイダ未設定"} のカタログが空）`,
					"warning",
				);
				return;
			}

			const modelKey = await pickFromList(ctx, "Select Cheap Sub Model", items);
			if (!modelKey) return;

			const selected = available.find((m) => `${m.provider}/${m.id}` === modelKey);
			if (!selected) {
				ctx.ui.notify(`cheap-model: 不正な値 "${modelKey}"`, "error");
				return;
			}
			const slash = modelKey.indexOf("/");
			const cfg: CheapModelConfig = {
				provider: modelKey.substring(0, slash),
				model: modelKey.substring(slash + 1),
			};

			// thinking 選択（対応レベルに絞れないときは全レベルを出し、Pi 側クランプに任せる）
			const thinkItems: SelectItem[] = [
				{
					value: "",
					label: "（指定しない）",
					description: "Pi 既定（--model にサフィックスを付けない）",
				},
				...supportedThinkingLevels(selected).map((lv) => ({
					value: lv,
					label: lv,
					description: current?.thinking === lv ? "現在の設定" : undefined,
				})),
			];
			const thinking = await pickFromList(ctx, "Select Thinking Level", thinkItems);
			if (thinking === null) return; // esc は全体キャンセル（保存しない）
			if (isValidThinkingLevel(thinking)) cfg.thinking = thinking;

			try {
				saveCheapModel(cfg);
				const display = `${cfg.provider}/${cfg.model}${cfg.thinking ? `:${cfg.thinking}` : ""}`;
				ctx.ui.notify(
					`cheap-model: ${display} を保存（spawn_cheap / 拡張内点検が使う。agent dir=${agentDir()}）`,
					"info",
				);
			} catch (e) {
				ctx.ui.notify(
					`cheap-model: 保存失敗 ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
			}
		},
	});
}