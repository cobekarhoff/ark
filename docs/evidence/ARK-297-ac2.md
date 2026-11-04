# ARK-297 AC2: live check

Fixture workspace outside the Ark repo (a temp git repo with a tracked skill `analyze` in `.claude/skills` and a nested repo `repos/svc-a`), with a temp `ARK_HOME` and a local ticket. omp 18.13.3, run from `<run>/workspace/repos/svc-a`. The fixture and its `ARK_HOME` were deleted after the check. No GitLab, GitHub or Orca was used.

Commands:

```sh
ark worktree anchor 2026-11-03-FAKE-1-1
ark worktree create 2026-11-03-FAKE-1-1 repos/svc-a
cd <run>/workspace/repos/svc-a
omp -p --no-session 'List the names of every skill available to you in this session, one per line. If a skill named analyze is available, say "analyze: available", otherwise say "analyze: not available". Do not use any tool.'
```

## With the key (config.yml as Ark wrote it)

```yaml
tools:
  approvalMode: yolo
skills:
  customDirectories:
    - <tmp>/ark-home/projects/demo/runs/2026-11-03-FAKE-1-1/workspace/.claude/skills
```

omp answer: the skill list includes `analyze`, and the last line is:

```text
analyze: available
```

## Without the key (`skills` removed by hand, same omp command)

```yaml
tools:
  approvalMode: yolo
```

omp answer: the skill list has no `analyze`, and the last line is:

```text
analyze: not available
```

proof: passed
