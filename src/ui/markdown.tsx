import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.ts';

/**
 * A small markdown renderer for the transcript.
 *
 * Assistant replies are written in markdown, and printing them raw means the
 * user reads asterisks and backticks instead of emphasis and code. This handles
 * the subset that actually shows up in a coding session: headings, lists,
 * fenced code, inline code, emphasis, links, quotes and rules.
 *
 * It is deliberately not a spec-complete parser — the failure mode for anything
 * unrecognized is "render it as plain text", which is exactly what happens today.
 */

/** Keywords worth colouring across the languages this CLI actually sees. */
const KEYWORDS = new Set([
  'import',
  'from',
  'export',
  'default',
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'class',
  'extends',
  'implements',
  'interface',
  'type',
  'enum',
  'new',
  'this',
  'super',
  'try',
  'catch',
  'finally',
  'throw',
  'async',
  'await',
  'yield',
  'typeof',
  'instanceof',
  'in',
  'of',
  'delete',
  'void',
  'null',
  'undefined',
  'true',
  'false',
  'public',
  'private',
  'protected',
  'readonly',
  'static',
  'def',
  'elif',
  'lambda',
  'pass',
  'raise',
  'with',
  'as',
  'not',
  'and',
  'or',
  'None',
  'True',
  'False',
  'fn',
  'let',
  'mut',
  'pub',
  'struct',
  'impl',
  'match',
  'use',
  'package',
  'func',
  'go',
  'defer',
  'select',
  'chan',
]);

const COMMENT = /^\s*(\/\/|#|--|\*|\/\*)/;

/** Colour one line of code. Cheap and approximate, but far better than flat. */
function highlight(line: string, key: number): React.ReactElement {
  const t = theme();
  if (COMMENT.test(line)) {
    return (
      <Text key={key} color={t.comment}>
        {line}
      </Text>
    );
  }
  // Split on strings first so keywords inside them are not recoloured.
  const parts = line.split(/(`[^`]*`|"[^"]*"|'[^']*')/g);
  return (
    <Text key={key}>
      {parts.map((part, i) => {
        if (!part) return null;
        if (/^["'`]/.test(part)) {
          return (
            <Text key={i} color={t.stringLit}>
              {part}
            </Text>
          );
        }
        return (
          <Text key={i}>
            {part.split(/(\b)/).map((word, j) => {
              if (KEYWORDS.has(word)) {
                return (
                  <Text key={j} color={t.keyword}>
                    {word}
                  </Text>
                );
              }
              if (/^\d+(\.\d+)?$/.test(word)) {
                return (
                  <Text key={j} color={t.number}>
                    {word}
                  </Text>
                );
              }
              return <Text key={j}>{word}</Text>;
            })}
          </Text>
        );
      })}
    </Text>
  );
}

/** Render inline spans: `code`, **bold**, *italic*, [text](url). */
export function inline(text: string, keyPrefix = ''): React.ReactNode[] {
  const t = theme();
  const out: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;

  // biome-ignore lint/suspicious/noAssignInExpressions: the standard exec-loop idiom for a global regex
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last)
      out.push(<Text key={keyPrefix + 't' + n++}>{text.slice(last, m.index)}</Text>);
    const tok = m[0];
    const k = keyPrefix + 's' + n++;

    if (tok.startsWith('`')) {
      out.push(
        <Text key={k} color={t.notice}>
          {tok.slice(1, -1)}
        </Text>,
      );
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      out.push(
        <Text key={k} bold>
          {tok.slice(2, -2)}
        </Text>,
      );
    } else if (tok.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      out.push(
        <Text key={k}>
          <Text underline color={t.user}>
            {link ? link[1] : tok}
          </Text>
          {link ? <Text dimColor>{' (' + link[2] + ')'}</Text> : null}
        </Text>,
      );
    } else {
      out.push(
        <Text key={k} italic>
          {tok.slice(1, -1)}
        </Text>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<Text key={keyPrefix + 't' + n++}>{text.slice(last)}</Text>);
  return out;
}

export function Markdown({ text }: { text: string }): React.ReactElement {
  const t = theme();
  const lines = text.split('\n');
  const blocks: React.ReactElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      blocks.push(
        <Box key={blocks.length} flexDirection="column" marginY={1} paddingLeft={2}>
          {fence[1] ? <Text dimColor>{fence[1]}</Text> : null}
          {body.map((b, n) => highlight(b, n))}
        </Box>,
      );
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <Box key={blocks.length} marginTop={blocks.length ? 1 : 0}>
          <Text bold color={heading[1].length === 1 ? t.notice : undefined}>
            {inline(heading[2], 'h' + i)}
          </Text>
        </Box>,
      );
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push(
        <Text key={blocks.length} dimColor>
          {'─'.repeat(40)}
        </Text>,
      );
      i++;
      continue;
    }

    // Blockquote.
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push(
        <Text key={blocks.length} dimColor italic>
          {'│ '}
          {inline(quote[1], 'q' + i)}
        </Text>,
      );
      i++;
      continue;
    }

    // Bullet or numbered list item.
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const indent = (bullet ?? numbered)![1].length;
      const marker = bullet ? '•' : numbered![2] + '.';
      const body = bullet ? bullet[2] : numbered![3];
      blocks.push(
        <Box key={blocks.length} paddingLeft={indent + 1}>
          <Text color={t.notice}>{marker + ' '}</Text>
          <Text>{inline(body, 'l' + i)}</Text>
        </Box>,
      );
      i++;
      continue;
    }

    if (!line.trim()) {
      blocks.push(<Text key={blocks.length}> </Text>);
      i++;
      continue;
    }

    blocks.push(<Text key={blocks.length}>{inline(line, 'p' + i)}</Text>);
    i++;
  }

  return <Box flexDirection="column">{blocks}</Box>;
}
