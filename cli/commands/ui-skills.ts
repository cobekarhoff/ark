import { uiSkills } from "../ui-skills.ts";
import type { Command } from "./types.ts";

export const uiSkillsCommand: Command = {
  usage: "ui-skills <run> [--project <name>]",
  description:
    "Prints the UI skills of the run, one line for each. When the Surfaces list in the recorded evaluation includes web_ui, it prints the required skills, then one more line for the React skill, which is only for a change that touches React code. For any other Surfaces list (none, cli_output or document alone), it prints none. It exits 1 for a run with no recorded evaluation. The Designer, the implementer, the validator and the reviewer read these skills; strategy record and plan check refuse a Skills line or a skills list that names any other skill.",
  flags: { "--project": true },
  minimum: 1,
  maximum: 1,
  run: ([runId], flags) => uiSkills(runId, flags["--project"] as string | undefined),
};
