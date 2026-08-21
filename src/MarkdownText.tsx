import { Fragment, ReactNode } from 'react';

type Props = {
  text: string;
  className?: string;
};

function safeHref(href: string): string | undefined {
  const value = href.trim();
  if (/^(https?:\/\/|mailto:)/i.test(value)) return value;
  return undefined;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^\s)]+\))/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));

    const token = match[0];
    const key = `${keyPrefix}-${tokenIndex++}`;

    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), `${key}-strong`)}</strong>);
    } else if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), `${key}-em`)}</em>);
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
      if (linkMatch) {
        const href = safeHref(linkMatch[2]);
        nodes.push(href
          ? <a key={key} href={href} target="_blank" rel="noreferrer noopener">{renderInline(linkMatch[1], `${key}-link`)}</a>
          : <Fragment key={key}>{linkMatch[1]}</Fragment>);
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(token);
    }

    cursor = index + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function isBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s+/.test(trimmed)
    || /^>\s?/.test(trimmed)
    || /^[-*+]\s+/.test(trimmed)
    || /^\d+\.\s+/.test(trimmed)
    || /^```/.test(trimmed)
    || /^(---|___|\*\*\*)$/.test(trimmed);
}

export default function MarkdownText({ text, className = '' }: Props) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const raw = lines[index];
    const line = raw.trim();

    if (!line) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([\w-]+)?\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={`code-${index}`} data-language={fence[1] || undefined}>
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2], `heading-${index}`);
      if (level === 1) blocks.push(<h2 key={`h-${index}`}>{content}</h2>);
      else if (level === 2) blocks.push(<h3 key={`h-${index}`}>{content}</h3>);
      else blocks.push(<h4 key={`h-${index}`}>{content}</h4>);
      index += 1;
      continue;
    }

    if (/^(---|___|\*\*\*)$/.test(line)) {
      blocks.push(<hr key={`hr-${index}`} />);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(<blockquote key={`quote-${index}`}>{renderInline(quoteLines.join(' '), `quote-${index}`)}</blockquote>);
      continue;
    }

    const unordered = /^[-*+]\s+/.test(line);
    const ordered = /^\d+\.\s+/.test(line);
    if (unordered || ordered) {
      const items: string[] = [];
      const itemPattern = unordered ? /^[-*+]\s+(.+)$/ : /^\d+\.\s+(.+)$/;
      while (index < lines.length) {
        const itemMatch = lines[index].trim().match(itemPattern);
        if (!itemMatch) break;
        items.push(itemMatch[1]);
        index += 1;
      }
      const children = items.map((item, itemIndex) => (
        <li key={`item-${index}-${itemIndex}`}>{renderInline(item, `item-${index}-${itemIndex}`)}</li>
      ));
      blocks.push(unordered
        ? <ul key={`list-${index}`}>{children}</ul>
        : <ol key={`list-${index}`}>{children}</ol>);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(<p key={`p-${index}`}>{renderInline(paragraph.join(' '), `p-${index}`)}</p>);
  }

  return <div className={`markdown-content ${className}`.trim()}>{blocks}</div>;
}
