import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";

/** One token of a highlighted line: text and its `--shiki-light` / `--shiki-dark` colour variables. */
export type HighlightToken = { content: string; style?: Record<string, string> };

const highlighter = createHighlighterCore({
  themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
  langs: [
    import("@shikijs/langs/typescript"),
    import("@shikijs/langs/javascript"),
    import("@shikijs/langs/json"),
    import("@shikijs/langs/yaml"),
    import("@shikijs/langs/shellscript"),
    import("@shikijs/langs/diff"),
    import("@shikijs/langs/python"),
    import("@shikijs/langs/markdown"),
    import("@shikijs/langs/gherkin"),
  ],
  engine: createJavaScriptRegexEngine(),
});

/** Tokens of `code` in `language`; null when the language is not one of the nine. */
export async function highlight(
  code: string,
  language: string,
): Promise<HighlightToken[][] | null> {
  const loaded = await highlighter;
  if (!loaded.getLoadedLanguages().includes(language.toLowerCase())) return null;
  const { tokens } = loaded.codeToTokens(code, {
    lang: language.toLowerCase(),
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
  return tokens.map((line) =>
    line.map((token) => ({
      content: token.content,
      style: token.htmlStyle as Record<string, string> | undefined,
    })),
  );
}
