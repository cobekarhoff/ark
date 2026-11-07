<!-- pr-writing:begin -->
> Written by an AI agent on behalf of @cobekarhoff, following their spec. @cobekarhoff has not reviewed it yet.

Refs: ARK-316.

## Problem

Refactors the reducer so memoized selectors no longer invalidate on shallow-equal args.

## What is different

- The body is rebuilt from the run on every new head.

## How to verify

- [ ] `bun test test/pr-writing.test.ts`. Expect: exits 0.

## Not done

- Nothing open.

## Risk and revert

Risk: a wrong rebuild would show a stale body, and the old text stays in the MR history.

Revert with `git revert <sha>` and run the open command again.

<!-- pr-writing:end -->
