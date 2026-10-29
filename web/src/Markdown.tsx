import { marked, type Token } from "marked";
import { Fragment, useState, type ReactNode } from "react";

import { safeLink } from "./markdown-links";
function CodeBlock({ text, language }: { text: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language || "code"}</span>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "已复制" : "复制代码"}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
/** Render lexer tokens as React nodes. Raw HTML and images never execute or fetch. */
export function Markdown({ text, onFile }: { text: string; onFile?: (path: string) => boolean }) {
  function render(tokens: Token[], depth = 0): ReactNode {
    if (depth > 30) return tokens.map((t) => t.raw).join("");
    return tokens.map((token, index) => {
      const children = () =>
        render(("tokens" in token ? token.tokens : undefined) ?? [], depth + 1);
      let node: ReactNode;
      switch (token.type) {
        case "space":
          return null;
        case "heading":
          node = (
            <p
              role="heading"
              aria-level={Math.min(token.depth + 1, 6)}
              className="markdown-heading"
            >
              {children()}
            </p>
          );
          break;
        case "paragraph":
          node = <p>{children()}</p>;
          break;
        case "text":
          node = token.tokens ? children() : token.text;
          break;
        case "strong":
          node = <strong>{children()}</strong>;
          break;
        case "em":
          node = <em>{children()}</em>;
          break;
        case "del":
          node = <del>{children()}</del>;
          break;
        case "codespan":
          node = <code>{token.text}</code>;
          break;
        case "code":
          node = <CodeBlock text={token.text} language={token.lang?.split(/\s/)[0]} />;
          break;
        case "blockquote":
          node = <blockquote>{children()}</blockquote>;
          break;
        case "br":
          node = <br />;
          break;
        case "hr":
          node = <hr />;
          break;
        case "list": {
          const items = token.items.map(
            (item: { tokens: Token[]; task?: boolean; checked?: boolean }, i: number) => (
              <li key={i}>
                {item.task && <input type="checkbox" checked={!!item.checked} readOnly disabled />}
                {render(item.tokens, depth + 1)}
              </li>
            ),
          );
          node = token.ordered ? (
            <ol start={Number(token.start) || 1}>{items}</ol>
          ) : (
            <ul>{items}</ul>
          );
          break;
        }
        case "link": {
          const url = safeLink(token.href);
          node = url ? (
            <a href={url} target="_blank" rel="noreferrer noopener">
              {children()}
            </a>
          ) : onFile && !/^[a-z][\w+.-]*:/i.test(token.href) ? (
            <button
              className="file-reference"
              onClick={() => {
                if (!onFile(token.href)) setMissing(token.href);
              }}
            >
              {children()}
            </button>
          ) : (
            <span>{children()}</span>
          );
          break;
        }
        case "table":
          node = (
            <div className="markdown-table">
              <table>
                <thead>
                  <tr>
                    {token.header.map((cell: { tokens: Token[] }, i: number) => (
                      <th key={i}>{render(cell.tokens, depth + 1)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {token.rows.map((row: { tokens: Token[] }[], i: number) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j}>{render(cell.tokens, depth + 1)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
          break;
        case "image":
          node = <span className="note">[图片：{token.text}]</span>;
          break;
        default:
          node = token.raw;
      }
      return <Fragment key={index}>{node}</Fragment>;
    });
  }
  const [missing, setMissing] = useState("");
  return (
    <div className="markdown">
      {render(marked.lexer(text))}
      {missing && (
        <p className="note" role="status">
          当前变更中没有文件：{missing}。暂仅支持跳转本轮变更文件。
        </p>
      )}
    </div>
  );
}
