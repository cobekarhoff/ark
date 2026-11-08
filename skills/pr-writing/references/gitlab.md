# GitLab (`glab`)

Used when the `origin` remote is a GitLab host. The scripts call `glab`; install and sign in once with `glab auth login`.

| Need                  | Command or behavior                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Check sign-in         | `glab auth status`. The token owner becomes `@handle` in the provenance line.                                                               |
| Open MR of the branch | `gather.ts --existing-only` (runs `glab api` on the open merge requests of the source branch).                                              |
| Create                | `post_mr.ts --confirmed` runs `glab mr create` with `--draft`; `--ready` leaves `--draft` off.                                              |
| Update                | `post_mr.ts --confirmed` runs `glab mr update` with the new description; it also assigns the token owner and adds reviewers. State is kept. |
| Template              | `.gitlab/merge_request_templates/Default.md`                                                                                                |
| Reviewers             | `reviewers` in `.pr-writing.toml`, passed to `--reviewer` at create and update.                                                             |
| Draft                 | `glab mr create --draft`. An update never changes the state.                                                                                |
| Link refs             | `!77` is an MR, `#12` an issue. `Depends on !77.` is checked by REF02.                                                                      |
| Missing auth          | Exit 2, `{"error":"not authenticated"}`. Run `glab auth login`. Nothing is posted.                                                          |
