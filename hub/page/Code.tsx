import { useEffect, useState } from "react";
import type { HighlightToken } from "./highlight.ts";

const FOLD_LINES = 12;

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <button
      type="button"
      className={done ? "copy done" : "copy"}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true))}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/** The box of a code or JSON block: label, Copy, the lines, and a fold past 12 lines. */
function Block({
  label,
  text,
  fold,
  children,
  testId,
}: {
  label: string;
  text: string;
  fold: boolean;
  children: React.ReactNode;
  testId: string;
}) {
  const [all, setAll] = useState(false);
  const folded = fold && !all;
  return (
    <figure className={folded ? "code folded" : "code"} data-testid={testId}>
      <figcaption>
        <span className="lang">{label}</span>
        <CopyButton text={text} />
      </figcaption>
      <pre tabIndex={0} aria-label={`${label} code`}>
        <code>{children}</code>
      </pre>
      {folded && (
        <button type="button" className="show-all" onClick={() => setAll(true)}>
          Show all
        </button>
      )}
    </figure>
  );
}

/**
 * A code block with a language label and a Copy button. Plain monospace text until the shiki
 * chunk loads (a dynamic import, so no other page pays for it), then coloured.
 */
export function Code({ code, language }: { code: string; language?: string }) {
  const [lines, setLines] = useState<{ key: string; tokens: HighlightToken[][] | null }>();
  const key = `${language ?? ""}\0${code}`;
  useEffect(() => {
    if (!language) return;
    let live = true;
    void import("./highlight.ts")
      .then((module) => module.highlight(code, language))
      .catch(() => null)
      .then((tokens) => live && setLines({ key, tokens }));
    return () => {
      live = false;
    };
  }, [key, code, language]);
  const tokens = lines?.key === key ? lines.tokens : null;
  return (
    <Block label={language || "text"} text={code} fold={false} testId="code-block">
      {tokens
        ? tokens.map((line, at) => (
            <span key={at}>
              {line.map((token, index) => (
                <span key={index} className="shiki-token" style={token.style}>
                  {token.content}
                </span>
              ))}
              {at < tokens.length - 1 ? "\n" : ""}
            </span>
          ))
        : code}
    </Block>
  );
}

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function jsonTokens(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const [whole, string, colon, literal] = match;
    if (string !== undefined) {
      nodes.push(
        <span key={match.index} className={colon ? "tk-key" : "tk-str"}>
          {string}
        </span>,
      );
      if (colon) nodes.push(colon);
    } else {
      nodes.push(
        <span key={match.index} className={literal ? "tk-lit" : "tk-num"}>
          {whole}
        </span>,
      );
    }
    last = match.index + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** A JSON value indented by 2 with token colours, folded to 12 lines behind Show all. Text that is not JSON shows as written. */
export function Json({ text }: { text: string }) {
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Not JSON: shown as written.
  }
  return (
    <Block
      label="json"
      text={pretty}
      fold={pretty.split("\n").length > FOLD_LINES}
      testId="json-block"
    >
      {jsonTokens(pretty)}
    </Block>
  );
}
