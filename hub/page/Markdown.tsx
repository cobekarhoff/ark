import { lazy, Suspense } from "react";
import { Lexer, type Token, type Tokens } from "marked";

// Lazy, never static: Code pulls shiki, and Home renders Markdown on the first load.
const Code = lazy(() => import("./Code.tsx").then((module) => ({ default: module.Code })));

/** A link is a link only when its target, trimmed and lower-cased, starts with one of these. */
const LINK_PREFIXES = ["http://", "https://", "/", "#"];
const safeTarget = (href: string) => {
  const target = href.trim().toLowerCase();
  return LINK_PREFIXES.some((prefix) => target.startsWith(prefix));
};

/** Semicolon-terminated character references of marked text, link and title values to their characters (CommonMark). A bare ampersand stays as written. A textarea reads its content as text, so no element is made. */
const CHARACTER_REFERENCE = /&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g;
let decoder: HTMLTextAreaElement | undefined;
const decode = (value: string) =>
  value.replace(CHARACTER_REFERENCE, (reference) => {
    decoder ??= document.createElement("textarea");
    decoder.innerHTML = reference;
    return decoder.value;
  });

function inline(tokens: Token[] | undefined): React.ReactNode {
  return tokens?.map((token, at) => {
    switch (token.type) {
      case "strong":
        return <strong key={at}>{inline((token as Tokens.Strong).tokens)}</strong>;
      case "em":
        return <em key={at}>{inline((token as Tokens.Em).tokens)}</em>;
      case "del":
        return <del key={at}>{inline((token as Tokens.Del).tokens)}</del>;
      case "codespan":
        return (
          <code key={at} className="ic">
            {(token as Tokens.Codespan).text}
          </code>
        );
      case "br":
        return <br key={at} />;
      case "link": {
        const link = token as Tokens.Link;
        const href = decode(link.href);
        return safeTarget(href) ? (
          <a
            key={at}
            href={href}
            title={link.title ? decode(link.title) : undefined}
            {...(/^\s*https?:\/\//i.test(href) ? { target: "_blank", rel: "noreferrer" } : {})}
          >
            {inline(link.tokens)}
          </a>
        ) : (
          link.raw
        );
      }
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens ? inline(text.tokens) : decode(text.text);
      }
      case "escape":
        return (token as Tokens.Escape).text;
      // html, image and anything else: the source as text.
      default:
        return token.raw;
    }
  });
}

function blocks(tokens: Token[]): React.ReactNode {
  return tokens.map((token, at) => {
    switch (token.type) {
      case "space":
      case "def":
        return null;
      case "heading": {
        const heading = token as Tokens.Heading;
        const Heading = `h${Math.min(heading.depth, 6)}` as "h1";
        return <Heading key={at}>{inline(heading.tokens)}</Heading>;
      }
      case "paragraph":
        return <p key={at}>{inline((token as Tokens.Paragraph).tokens)}</p>;
      case "text": {
        const text = token as Tokens.Text;
        return <p key={at}>{text.tokens ? inline(text.tokens) : decode(text.text)}</p>;
      }
      case "hr":
        return <hr key={at} />;
      case "blockquote":
        return <blockquote key={at}>{blocks((token as Tokens.Blockquote).tokens)}</blockquote>;
      case "code": {
        const code = token as Tokens.Code;
        return (
          <Suspense key={at} fallback={<pre className="code-plain">{code.text}</pre>}>
            <Code code={code.text} language={code.lang?.split(/\s/)[0]} />
          </Suspense>
        );
      }
      case "list": {
        const list = token as Tokens.List;
        const Tag = list.ordered ? "ol" : "ul";
        return (
          <Tag
            key={at}
            start={list.ordered && list.start !== 1 ? list.start || undefined : undefined}
          >
            {list.items.map((item, index) => (
              <li key={index}>
                {item.task && <input type="checkbox" checked={item.checked} disabled readOnly />}
                {tight(item.tokens)}
              </li>
            ))}
          </Tag>
        );
      }
      case "table": {
        const table = token as Tokens.Table;
        const align = (column: number) => table.align[column] ?? undefined;
        return (
          <div key={at} className="tablewrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  {table.header.map((cell, column) => (
                    <th key={column} style={{ textAlign: align(column) }}>
                      {inline(cell.tokens)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, column) => (
                      <td key={column} style={{ textAlign: align(column) }}>
                        {inline(cell.tokens)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      // html and anything else: the source as text.
      default:
        return <p key={at}>{token.raw}</p>;
    }
  });
}

/** List item content: a lone text token is inline (no paragraph), the rest are blocks. */
function tight(tokens: Token[]): React.ReactNode {
  return tokens.map((token, at) =>
    token.type === "text" ? (
      <span key={at}>{inline((token as Tokens.Text).tokens ?? [token])}</span>
    ) : (
      blocks([token])
    ),
  );
}

/**
 * Markdown as React elements from the marked lexer tokens. No HTML is ever made from the text:
 * raw HTML shows as text, and a link target outside http://, https://, / and # shows as text.
 * `raw` shows the source as written.
 */
export function Markdown({
  text,
  raw = false,
  testId,
}: {
  text: string;
  raw?: boolean;
  testId?: string;
}) {
  return raw ? (
    <pre className="raw" tabIndex={0} data-testid={testId}>
      {text}
    </pre>
  ) : (
    <div className="md" data-testid={testId}>
      {blocks(Lexer.lex(text))}
    </div>
  );
}

/** The Rendered / Raw switch. */
export function ViewSwitch({ raw, onChange }: { raw: boolean; onChange: (raw: boolean) => void }) {
  return (
    <div className="seg" role="group" aria-label="View">
      <button type="button" aria-pressed={!raw} onClick={() => onChange(false)}>
        Rendered
      </button>
      <button type="button" aria-pressed={raw} onClick={() => onChange(true)}>
        Raw
      </button>
    </div>
  );
}
