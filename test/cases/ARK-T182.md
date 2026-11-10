---
id: ARK-T182
title: ARK-T182 the run page links the run files that exist, shows them rendered, a missing file has no link, and a path outside the run folder answers 404
level: e2e
technique: equivalence classes of paths (present, missing, outside the run folder through `..`, absolute and symlink forms)
priority: medium
risk: "a run file that exists has no link, a missing file or a file outside the run folder has a link or is served, a file shows as raw text instead of through its renderer, or a path that leaves the run folder answers 200"
status: active
changed_by: 2026-11-09-ARK-323-1
---

## Objective

Prove the run page links the run files that exist and shows them through the right renderer. Expected: When a run file is opened, the system shall show its text through the right renderer and answer 404 for a path outside the run folder.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts` on a hub with project `p` and fake Orca tools.
- A closed run with `ticket.md`, `plan.md` (`# Plan`, a paragraph and a raw `<b>` tag), `findings/note.md`, no `strategies.md` or `retro.md`, and symlinks `findings/leak.md` and `results` that lead outside the run folder to a file holding `TOPSECRET`.

## Steps

1. Open the run page. Assert the run file links are `ticket.md`, `plan.md` and `findings/note.md` in that order: a missing file and both symlinks have no link.
2. Open `plan.md`. Assert the `Plan` heading is an `h1` element, the raw `<b>not markup</b>` shows as text and makes no `b` element.
3. Open `findings/note.md`. Assert its text shows.
4. Open the page path `../ticket.md`. Assert `file-missing` shows.
5. Request `/api/run/<run>/file?path=plan.md`. Assert 200.
6. Request each path out of the run folder (`..`, absolute, `./`, symlink, encoded, a missing file and no `path`). Assert each answers 404 and none holds `TOPSECRET`.

## Expected results

- When a run file exists, the system shall link it and show it through its renderer (a `.md` file through Markdown).
- When the file is missing or outside the run folder, the system shall show no link and answer 404.

## Screenshot checkpoints

None.
