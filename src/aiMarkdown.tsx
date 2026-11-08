import { Fragment, useMemo, type ReactNode } from "react";

/**
 * Tiny markdown renderer for AI answers.
 *
 * Every provider answers in markdown (`**bold**`, lists, fenced code). Showing
 * the raw text left the asterisks and backticks in the panel, which looked
 * broken and made long answers hard to read. This covers what chat answers
 * actually use and keeps the bundle free of a parser dependency; anything it
 * does not recognise is printed as plain text.
 */

type Block =
  | { kind: "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { kind: "paragraph"; text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])\1{2,}\s*$/;
const BULLET = /^\s*[-*+•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,2})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const FENCE = /^\s*```/;

const INLINE_SOURCE =
  "(\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__|~~[^~\\n]+~~|`[^`\\n]+`|\\*[^*\\n]+\\*|_[^_\\n]+_|\\[[^\\]\\n]+\\]\\([^)\\s]+\\))";

function isBlockStart(line: string): boolean {
  return (
    !line.trim() ||
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line)
  );
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (FENCE.test(line)) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence, or end of the answer
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: Math.min(heading[1].length, 3),
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        quote.push(QUOTE.exec(lines[index])![1]);
        index += 1;
      }
      blocks.push({ kind: "quote", text: quote.join(" ").trim() });
      continue;
    }

    const numbered = NUMBERED.exec(line);
    if (BULLET.test(line) || numbered) {
      const ordered = Boolean(numbered);
      const start = numbered ? Number(numbered[1]) : 1;
      const items: string[] = [];
      while (index < lines.length) {
        const nextBullet = BULLET.exec(lines[index]);
        const nextNumbered = NUMBERED.exec(lines[index]);
        if (nextBullet) items.push(nextBullet[1].trim());
        else if (nextNumbered) items.push(nextNumbered[2].trim());
        else break;
        index += 1;
      }
      blocks.push({ kind: "list", ordered, start, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !isBlockStart(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = new RegExp(INLINE_SOURCE, "g");
  let last = 0;
  let count = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${count++}`;

    if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("~~")) {
      nodes.push(<del key={key}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith("[")) {
      // Links stay text: the notch is not a browser and must never navigate.
      nodes.push(
        <span key={key} className="ai-md-link">
          {token.slice(1, token.indexOf("]"))}
        </span>,
      );
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }

    last = match.index + token.length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderBlock(block: Block, index: number): ReactNode {
  const key = `block-${index}`;

  switch (block.kind) {
    case "code":
      return (
        <pre key={key}>
          <code>{block.text}</code>
        </pre>
      );
    case "heading":
      return (
        <div key={key} className={`ai-md-heading ai-md-h${block.level}`}>
          {renderInline(block.text, key)}
        </div>
      );
    case "list":
      return block.ordered ? (
        <ol key={key} start={block.start}>
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key}>
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
          ))}
        </ul>
      );
    case "quote":
      return <blockquote key={key}>{renderInline(block.text, key)}</blockquote>;
    case "rule":
      return <hr key={key} />;
    default:
      return <p key={key}>{renderInline(block.text, key)}</p>;
  }
}

export function AiMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);

  return (
    <div className="ai-md">
      {blocks.map((block, index) => (
        <Fragment key={index}>{renderBlock(block, index)}</Fragment>
      ))}
    </div>
  );
}
