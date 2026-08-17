/**
 * Minimal markdown renderer for the AI fire summaries — headings, paragraphs,
 * lists, bold/italic/code, and links (open in a new tab). Builds React
 * elements directly (no HTML injection). Deliberately dependency-free: the
 * summaries are simple generated markdown, not arbitrary documents.
 * Styling lives in panels.css under `.rd-md`.
 */
import { Fragment, type ReactNode } from 'react';

/** Inline: links, bold, italic, inline code. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Tokenize links first, then emphasis inside the remaining text.
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  const pushText = (chunk: string) => {
    // bold ** ** then italic * * then `code`
    const parts = chunk.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g);
    for (const p of parts) {
      if (!p) continue;
      const k = `${keyBase}-${i++}`;
      if (p.startsWith('**') && p.endsWith('**')) {
        out.push(<strong key={k}>{p.slice(2, -2)}</strong>);
      } else if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
        out.push(<code key={k}>{p.slice(1, -1)}</code>);
      } else if (p.startsWith('*') && p.endsWith('*') && p.length > 2) {
        out.push(<em key={k}>{p.slice(1, -1)}</em>);
      } else {
        out.push(<Fragment key={k}>{p}</Fragment>);
      }
    }
  };
  while ((m = linkRe.exec(text)) !== null) {
    if (m.index > last) pushText(text.slice(last, m.index));
    out.push(
      <a key={`${keyBase}-l${i++}`} href={m[2]} target="_blank" rel="noopener noreferrer">
        {m[1]}
      </a>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) pushText(text.slice(last));
  return out;
}

export function Markdown({ children }: { children: string }) {
  const blocks: ReactNode[] = [];
  const lines = children.split(/\r?\n/);
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(' ').trim();
    if (text) blocks.push(<p key={key++}>{renderInline(text, `p${key}`)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, j) => <li key={j}>{renderInline(it, `li${key}-${j}`)}</li>);
    blocks.push(list.ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);

    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (h) {
      flushPara();
      flushList();
      const level = Math.min(h[1].length + 2, 6); // #→h3 … keeps panel hierarchy
      const Tag = `h${level}` as 'h3';
      blocks.push(<Tag key={key++}>{renderInline(h[2], `h${key}`)}</Tag>);
    } else if (ul || ol) {
      flushPara();
      const item = (ul ?? ol)![1];
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();

  return <div className="rd-md">{blocks}</div>;
}
