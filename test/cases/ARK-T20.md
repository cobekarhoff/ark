---
id: ARK-T20
title: ARK-T20 screenshot pairs, missing sides and image route refusals
level: e2e
technique: equivalence classes of a checkpoint (both sides, no before, no after); error guessing on path attacks (dot-dot, symlink out, non-image)
priority: high
risk: "a pair is stacked or swapped, an image has no alt text naming case, checkpoint and side, a missing side shows a broken image, or the image route serves a file outside the run folder, a symlink target or a text file"
status: active
changed_by: 2026-11-06-ARK-314-1
---

## Objective

Prove screenshot checkpoints show as a before-left, after-right pair with alt text, a missing side shows the words `no before screenshot` or `no after screenshot`, and the image route answers 404 for `..`, an escaping symlink and a non-image file.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`. Fixture run with UI case `ARK-T7` in the plan, evidence folder `results/evidence/ARK-T7/{base,head}/screenshots/` holding real small PNG files:
  - checkpoint `login` : `base/screenshots/login.png` and `head/screenshots/login.png` (both).
  - checkpoint `list` : only `head/screenshots/list.png` (no before).
  - checkpoint `detail` : only `base/screenshots/detail.png` (no after).
- Bad paths prepared in the fixture: `results/evidence/ARK-T7/head/screenshots/escape.png` is a symlink to a real PNG outside the run folder (in the temp dir); `results/evidence/ARK-T7/head/screenshots/notes.txt` is a text file; the request path `results/evidence/ARK-T7/head/screenshots/../../../../state.json`.
- Mapping used in the page: the `base` side is `before`, the `head` side is `after`.

## Steps

1. Open the run page. `checkpoint(page, "screenshot-pairs")`.
2. Assert three checkpoint groups with the names `login`, `list`, `detail` shown above each pair.
3. For `login` assert two images, the before image to the left of the after image (bounding box x of before < x of after, same row), and each image fully loaded (`naturalWidth > 0`).
4. Assert the `alt` texts contain the case, checkpoint and side, for example `ARK-T7 login before` and `ARK-T7 login after`.
5. For `list` assert the left slot holds the exact words `no before screenshot` and no `img` for the before side. For `detail` assert the right slot holds `no after screenshot` and no `img`.
6. Assert the page has no `img` with `naturalWidth` 0 (no broken image) and that no request answered 404.
7. With the request context, GET the image URL of `login` after: assert 200, `content-type` `image/png`, header `x-content-type-options: nosniff`.
8. GET the `..` path, the symlink path and the text file path (raw, unnormalized request so `..` reaches the server). Assert each answers 404 and the body holds no content of `state.json`, the outside PNG or the text file.
9. Assert POST to the image URL does not return 200 (GET only).

## Expected results

- Each named screenshot checkpoint shall show as one pair, before on the left and after on the right, with the checkpoint name above the pair.
- Each image shall have an `alt` text that names the case, the checkpoint and the side.
- If a checkpoint has no before image, then the system shall show the words `no before screenshot`; if no after image, `no after screenshot`; never a broken image.
- The image route shall serve an image with `x-content-type-options: nosniff` and shall answer 404 for a path with `..`, for a symlink that leaves the run folder and for a file that is not an image.

## Screenshot checkpoints

- `screenshot-pairs`: the three checkpoints, one full pair and the two missing-side texts.
