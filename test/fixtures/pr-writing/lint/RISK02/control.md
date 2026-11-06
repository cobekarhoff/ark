<!-- pr-writing:begin -->
> Written by an AI agent on behalf of @cobekarhoff, following their spec. @cobekarhoff has not reviewed it yet.

Refs: ARK-316.

## Problem

An MR body listed a bug that was already fixed, so reviewers chased a problem that was gone.

## What is different

- The body is rebuilt from the run on every new head.

## How to verify

- [ ] `bun test test/pr-writing.test.ts`. Expect: exits 0.

## Not done

- Nothing open.

## Risk and revert

Risk: the new column stays after a revert, so old code runs against the new schema.

Migration rollback: run the down script by hand, then `git revert <sha>`.

<!-- pr-writing:end -->
