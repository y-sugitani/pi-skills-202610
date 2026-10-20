import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    const t = event.text.trim().toLowerCase();
    if (t === "exit" || t === "quit" || t === "bye") {
      ctx.shutdown();
      return { action: "handled" };
    }
  });

  pi.registerCommand("exit", {
    description: "Exit pi",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });
}
