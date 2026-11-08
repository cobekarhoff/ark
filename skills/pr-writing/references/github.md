# GitHub (`gh`)

Used when the `origin` remote is github.com or a GitHub Enterprise host. The scripts call `gh`; sign in once with `gh auth login`.

| Need                  | Command or behavior                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Check sign-in         | `gh auth status`. The token owner becomes `@handle` in the provenance line.                                                |
| Open PR of the branch | `gather.ts --existing-only` (runs `gh pr list` for the head branch).                                                       |
| Create                | `post_mr.ts --confirmed` runs `gh pr create` with `--draft`; `--ready` leaves `--draft` off.                               |
| Update                | `post_mr.ts --confirmed` runs `gh pr edit --body-file`; it also assigns the token owner and adds reviewers. State is kept. |
| Template              | `.github/pull_request_template.md` (also `docs/` or root, see `lib/ledger.ts`).                                            |
| Reviewers             | `reviewers` in `.pr-writing.toml`, passed to `--reviewer` at create and `--add-reviewer` at update.                        |
| Draft                 | A Draft PR is a PR flagged draft, not a title prefix.                                                                      |
| Link refs             | `#77` is a PR or issue. `Depends on #77.` is checked by REF02.                                                             |
| Missing auth          | Exit 2, `{"error":"not authenticated"}`. Run `gh auth login`. Nothing is posted.                                           |
