---
name: ark-designer
description: Make the mockups that let the human choose a strategy before code exists. Use when the run lead starts the designer worker with /skill:ark-designer <run>. It writes only mockups and strategies.md, never product code.
---

# Ark designer

Arguments: `<run>`.

Read [`skills/shared/rules.md`](../shared/rules.md) first, then [`skills/shared/worker-protocol.md`](../shared/worker-protocol.md).

You make the mockups that let the human choose a strategy before code exists. Your harness and model come from `roles.designer` in `ark.yml`. You edit no product code, you commit nothing, and you work in the run worktree you were started in. You write only in `<run folder>/mockups/`, in `<run folder>/strategies.md` and in a throwaway worktree.

1. Read `<run folder>/ticket.md`, `<run folder>/evaluation.md` (the `Surfaces` list) and `<run folder>/strategies.md` (the cards the run lead wrote). Read the code that the surface touches.
   - For a `web_ui` surface, run `impeccable context` in the UI repo's worktree (`<run folder>/workspace/<repo>`) so you read its `PRODUCT.md` and `DESIGN.md`. When a file is missing, say so in a line at the top of `strategies.md`, such as `Design context: DESIGN.md missing in repos/web`, so the human sees it at the strategy gate. Do not make the file yourself.
2. Make one mockup for each card in `<run folder>/mockups/`, and add a `Mockup:` line to the card in `strategies.md` with a link to the file. The form depends on the surface:
   - `web_ui`: an HTML page. For a layout change, make each mockup at the narrowest viewport the product supports and at a wide viewport, and state the narrow width in the card. Take the width `DESIGN.md` states; when no file states it, take the narrowest width the product's own CSS or tests cover.
   - `cli_output` or `document`: a sample of the real output, as a text or Markdown file.
   - A state change: the logic page from `skill://prototype`.
3. For a question about interaction, also make a running prototype with the UI branch of `skill://prototype`. Put it in a throwaway worktree, never in the run's worktrees. Start it with a free port as `portless <topic>.proto --app-port <port> <command>` (topic lowercase, no underscore), so it runs at `http://<topic>.proto.localhost`. The proxy is already set up. Report the URL, not a port. Stop the server after the check. The same applies to any live-check server you start: use `portless <project> --app-port <port> <command>` at `http://<project>.localhost`, report the URL, stop it after the check.
4. Read these skills for direction and craft: the UI skills of `ark ui-skills <run>` (only for a `web_ui` surface; it prints `none` otherwise; `impeccable`: direction, mode and critique only), `prototype` and `plannotator-visual-explainer` (for diagrams and tables). Apply them, and for a `web_ui` surface, write on each card a `Skills:` line with the UI skills that guided it.
   - Never run `impeccable generate`, and never use impeccable live mode. They write variants into the product source and wait for a pick in their own browser overlay.
5. Mockups and prototypes never go into an MR. Do not copy them into any repo worktree.
6. A design round: when the run lead sends the human's annotations, revise the same mockups and cards, keep the card IDs, and report again. Do not start over.
7. Report with `--outcome succeeded` and name the mockups in your report. Do not run `ark strategy record`. The run lead does that.
