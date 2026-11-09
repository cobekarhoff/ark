---
id: ARK-T147
title: ARK-T147 the band links retro.md and each findings file that exists and no link for an absent file
level: integration
technique: equivalence classes (both exist, neither exists) and boundary (findings with a name that needs URL-encoding)
priority: medium
risk: the band links a file that does not exist (dead link), omits one that does, links through a route that does not resolve, or breaks on a findings name with a space or special character
status: active
changed_by: 2026-11-09-ARK-353-1
---

## Objective

Prove that the band's links follow the files on disk.

## Preconditions

- A hub started on a scratch `ARK_HOME` with real run folders (events, `state.json`, files), real snapshot and `runDetail()` code, and a real browser (Playwright, `test/pw/hub.pw.ts`). No mocks of the page or of the snapshot.
- Run A: has `retro.md` and `findings/review round 1.md` and `findings/qe.md`.
- Run B: has neither `retro.md` nor a `findings/` folder.

## Steps

1. Open the page of run A, list the links in the band.
2. Click each link and read the response.
3. Open the page of run B and list the links in the band.

## Expected results

- The band of A shall link `retro.md` and each of the two findings files.
- Each link shall open that file's content through the existing run-file route (HTTP 200), including the name with a space.
- The band of B shall show no retro link and no findings link, and no empty placeholder link.
- Deleting `retro.md` from A and reloading shall remove its link.

## Screenshot checkpoints

Band of run A with the links; band of run B without.
