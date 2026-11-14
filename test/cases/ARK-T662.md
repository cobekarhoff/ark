---
id: ARK-T662
title: ARK-T662 the three hub write routes of the Companions page refuse a request that did not come from the hub's own page and a name, ticket or item outside the companions, the page's GET route survives an invalid `ark.yml`, and every other route still refuses writes
level: integration
technique: equivalence classes of request origin (own page, no Origin, foreign Origin, foreign Host), of target (listed companion, unlisted, traversal in plain and percent-encoded form, ticket of another source) and of body (inside the cap, over the cap, bad JSON); route enumeration for the write-method rule
priority: high
risk: "any web page open in the user's browser posts to 127.0.0.1 and approves a ticket, writes dismissed.md or wakes a companion, because the new routes use the lax isLocalRequest of the read routes (a missing Origin passes there); a name or ticket id with `..` writes outside companions/ or changes a ticket that no companion proposed; a body over 1024 bytes answers an opaque error; the new GET route crashes the snapshot when ark.yml is invalid; the old read-only rule is re-pinned or dropped, so another route takes a write unnoticed"
status: active
changed_by: 2026-11-14-ARK-480-1
---

## Objective

Prove that the three writes of the Companions page (approve a ticket, dismiss with a reason, ask) go through routes that accept only a POST from the hub's own page, touch only a listed companion's files and the proposed tickets that name it, and that ADR 0009's rule, amended for these three routes, still holds for every other route. Serves ARK-480/AC7.

## Preconditions

- A real hub on a temp `ARK_HOME` (the harness of `test/hub.test.ts`), the fake orca of ARK-T660 (logs `send`, `task-create`), project `p` with the companion `cortana` listed, a ticket `ARK-901` at `status: proposed` with `source: cortana`, a ticket `ARK-902` at `status: proposed` with no `source`, a ticket `ARK-903` at `status: ready`.
- Authorities: the hub's `127.0.0.1:<port>` as in `openInOrca`.

## Steps

1. For each of the three routes, POST a good body with `Origin` and `Host` equal to the hub's authority.
2. For each route, POST the same body with no `Origin`, with a foreign `Origin`, and with a foreign `Host`.
3. POST approve for `ARK-902` (no `source`), `ARK-903` (ready), an unknown id, `../tickets/ARK-901` and `..%2f..%2fark.yml`; POST dismiss and ask for `ghost` and `../x`; POST dismiss with a body over 1024 bytes, with bad JSON and with an empty reason.
4. Make `ark.yml` invalid (`companions: 3`). GET the page's data route, `/api/snapshot` and `/`.
5. Send POST, PUT, PATCH and DELETE to every served route (`/`, `/api/snapshot`, `/events`, a run route, the assets), to routes that do not exist, and to the three companion routes; send GET, PUT, PATCH and DELETE to each companion route and to `open-in-orca`. This is the write-method sweep of `test/hub.test.ts`, which this case takes over from `ARK-277-AC2`.

## Expected results

- Step 1: approve sets `ARK-901` to `status: ready` (one line changed) and no `task-create`; dismiss appends the reason to `companions/cortana/dismissed.md`; ask sends one message to the companion's worker. Each answers 200 with a JSON result.
- Step 2: every one of the nine requests answers 403, and no file changed and no call was logged (a missing Origin is refused here, unlike on a GET).
- Step 3: approve of `ARK-902`, `ARK-903`, the unknown id and both traversal ids answers 404 or 400 and changes no file (`ARK-902` and `ARK-903` are not a companion's proposal); a name `ghost` or `../x` answers 404 or 400 and writes no file anywhere; the body over the cap answers a clear 413 or 400 with a reason, not a dropped connection; bad JSON answers 400; an empty reason answers 400 and writes nothing.
- Step 4: with an invalid `ark.yml` the data route answers with an error body for the page's own message, and the snapshot and `/` answer 200 as before.
- Step 5: every route but `open-in-orca` and the three companion routes answers a write method with 404 or 405; each companion route and `open-in-orca` answers a GET, PUT, PATCH and DELETE with 405. The test `ARK-277-AC2` that pinned the old rule is converted to this case's id with the amended rule, not re-pinned.

## Screenshot checkpoints

None. The surface is HTTP; ARK-T660 covers the page.
