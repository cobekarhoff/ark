import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { join } from "node:path";

// Spike: typed tool that runs the CLI. via=path -> `ark` from PATH; via=file -> bun on the package's own cli file.
const factory: CustomToolFactory = (pi) => ({
  name: "ark_spike",
  label: "Ark Spike",
  description: "ARK-101 spike: runs the ark CLI with given args and returns its JSON output.",
  parameters: pi.zod.object({
    args: pi.zod.array(pi.zod.string()).optional(),
    via: pi.zod.enum(["path", "file"]).optional(),
  }),
  async execute(_id, params, _onUpdate, _ctx, signal) {
    const args = params.args ?? [];
    const r =
      params.via === "file"
        ? await pi.exec("bun", [join(import.meta.dir, "..", "cli", "ark.ts"), ...args], { signal, cwd: pi.cwd })
        : await pi.exec("ark", args, { signal, cwd: pi.cwd });
    if (r.code !== 0) throw new Error(r.stderr || `ark exited ${r.code}`);
    return { content: [{ type: "text", text: r.stdout.trim() }], details: { args } };
  },
});

export default factory;
