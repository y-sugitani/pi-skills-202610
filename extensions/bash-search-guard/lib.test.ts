import { describe, expect, mock, test } from "bun:test";
import { inspectBashCommand, maskNonCode } from "./lib.ts";

// 配布先（~/.pi 等）に node_modules が無いので、pi 本体はスタブして配線だけ見る
mock.module("@earendil-works/pi-coding-agent", () => ({
	isToolCallEventType: (toolName: string, event: { toolName?: string }) =>
		event?.toolName === toolName,
}));
const { default: bashSearchGuard } = await import("./index.ts");

const blocked = (command: string) => inspectBashCommand(command);
const allowed = (command: string) => !inspectBashCommand(command).blocked;

describe("bash-search-guard: block する（コマンド位置の find / grep）", () => {
	test("先頭", () => {
		expect(blocked("find . -name '*.ts'")).toMatchObject({ blocked: true, command: "find" });
		expect(blocked("grep -rn foo src")).toMatchObject({ blocked: true, command: "grep" });
		expect(blocked("egrep a b")).toMatchObject({ blocked: true, command: "egrep" });
		expect(blocked("fgrep a b")).toMatchObject({ blocked: true, command: "fgrep" });
	});

	test("パス付き（/usr/bin/find, /bin/grep）", () => {
		expect(blocked("/usr/bin/find .")).toMatchObject({ blocked: true, command: "find" });
		expect(blocked("/bin/grep x")).toMatchObject({ blocked: true, command: "grep" });
		expect(blocked("/opt/homebrew/bin/find .")).toMatchObject({ blocked: true });
	});

	test("パイプ・&&・||・;・改行", () => {
		expect(blocked("ls | grep foo")).toMatchObject({ blocked: true, command: "grep" });
		expect(blocked("true && find .")).toMatchObject({ blocked: true, command: "find" });
		expect(blocked("false || egrep a b")).toMatchObject({ blocked: true });
		expect(blocked("cd x; fgrep a b")).toMatchObject({ blocked: true });
		expect(blocked("cd x\nfind .")).toMatchObject({ blocked: true });
		expect(blocked("echo hi & grep x")).toMatchObject({ blocked: true });
	});

	test("$() とバッククォートの中", () => {
		expect(blocked("echo $(find . -name x)")).toMatchObject({ blocked: true, command: "find" });
		expect(blocked("x=`grep foo bar`")).toMatchObject({ blocked: true, command: "grep" });
		expect(blocked('echo "$(find .)"')).toMatchObject({ blocked: true });
		expect(blocked("echo $(echo $(find .))")).toMatchObject({ blocked: true });
	});

	test("制御構文・wrapper 越し", () => {
		expect(blocked("if find . -name x; then echo; fi")).toMatchObject({ blocked: true });
		expect(blocked("for f in a; do grep x \"$f\"; done")).toMatchObject({ blocked: true });
		expect(blocked("sudo find / -name x")).toMatchObject({ blocked: true });
		expect(blocked("sudo -u root find / -name x")).toMatchObject({ blocked: true });
		expect(blocked("env FOO=1 find .")).toMatchObject({ blocked: true });
		expect(blocked("command find .")).toMatchObject({ blocked: true });
		expect(blocked("time find .")).toMatchObject({ blocked: true });
		expect(blocked("\\find .")).toMatchObject({ blocked: true });
	});
});

describe("bash-search-guard: 通す（fd / rg・文字列・コメント・別コマンドの引数）", () => {
	test("fd / rg とその周辺", () => {
		expect(allowed("fd -e ts")).toBe(true);
		expect(allowed("rg -n 'foo' src")).toBe(true);
		expect(allowed("cd x && rg --files | head")).toBe(true);
		expect(allowed("rg foo | wc -l")).toBe(true);
		expect(allowed("echo $(rg foo | head -1)")).toBe(true);
	});

	test("文字列・コメント中の語", () => {
		expect(allowed('echo "find . -name x"')).toBe(true);
		expect(allowed("echo 'grep foo bar'")).toBe(true);
		expect(allowed('rg "find" .')).toBe(true);
		expect(allowed("rg -n 'grep|find' src")).toBe(true);
		expect(allowed("echo \"$(rg 'find')\"")).toBe(true);
		expect(allowed("# find . -name x")).toBe(true);
		expect(allowed("rg foo # grep でなく rg")).toBe(true);
		expect(allowed("echo 'a; grep x'")).toBe(true);
	});

	test("別コマンドの引数・リダイレクト先・ローカル script", () => {
		expect(allowed("git grep foo")).toBe(true);
		expect(allowed("man find")).toBe(true);
		expect(allowed("rg --iglob find .")).toBe(true);
		expect(allowed("echo x > find")).toBe(true);
		expect(allowed("ls > /tmp/find")).toBe(true);
		expect(allowed("command -v find")).toBe(true);
		expect(allowed("./find .")).toBe(true);
		expect(allowed("findx .")).toBe(true);
		expect(allowed("cat find.txt")).toBe(true);
	});

	test("マスク結果（引用の追跡）", () => {
		expect(maskNonCode("echo 'find' | rg foo").trim().replace(/\s+/g, " ")).toBe(
			"echo | rg foo",
		);
		expect(maskNonCode("echo $(find .)").replace(/\s+/g, " ").trim()).toBe("echo ( find .");
	});
});

describe("bash-search-guard: tool_call 配線", () => {
	const runHandler = async (toolName: string, command: string) => {
		let handler:
			| ((event: unknown, ctx: unknown) => Promise<unknown> | unknown)
			| undefined;
		const pi = {
			on: (name: string, fn: typeof handler) => {
				if (name === "tool_call") handler = fn;
			},
			registerCommand: () => {},
		};
		bashSearchGuard(pi as never);
		if (!handler) throw new Error("tool_call handler 未登録");
		return await handler({ toolName, input: { command } }, {});
	};

	test("bash の find は block され reason が付く", async () => {
		const result = (await runHandler("bash", "find . -name x")) as {
			block?: boolean;
			reason?: string;
		};
		expect(result.block).toBe(true);
		expect(result.reason).toContain("bash-search-guard");
		expect(result.reason).toContain("rg");
	});

	test("bash の rg / fd は通す", async () => {
		expect(await runHandler("bash", "rg -n foo src")).toBeUndefined();
		expect(await runHandler("bash", "fd -e ts")).toBeUndefined();
	});

	test("Pi ツールの find / grep（bash 以外）は対象外", async () => {
		expect(await runHandler("find", "find .")).toBeUndefined();
		expect(await runHandler("grep", "grep foo")).toBeUndefined();
	});
});
