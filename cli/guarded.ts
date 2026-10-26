// The tools the main session's hook decides about (cli/hook.ts); the extension shim loads this list too, so the two cannot drift apart.
export const GUARDED = ["edit", "write", "ast_edit", "bash", "eval", "lsp"];
