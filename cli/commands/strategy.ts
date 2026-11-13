import { strategyRecord } from "../strategy.ts";
import type { Command } from "./types.ts";

export const strategyRecordCommand: Command = {
  usage: "strategy record <run> [--project <name>]",
  description:
    "Reads strategies.md in the run folder and records its strategy cards: the count, the recommended card and the card IDs. It refuses a missing file, a card with no approach, interfaces or tradeoffs, a mockup link to a file that is not in the run folder, a run with no evaluation record, one card with no reason, and, when the evaluation lists a surface other than none, a card with no mockup link, and, when the surfaces include web_ui, a card with no Skills line or a Skills line that names a skill `ark ui-skills <run>` does not list, or a project whose ark.yml has no roles.designer. A mockup and roles.designer are not needed when the surface is only none, or when there is one card and the surfaces are only cli_output, document or none. A Skills line is needed only when the surfaces include web_ui. Two or more cards open the strategy gate; one card opens no gate.",
  flags: { "--project": true },
  minimum: 1,
  maximum: 1,
  run: ([runId], flags) => strategyRecord(runId, flags["--project"] as string | undefined),
};
