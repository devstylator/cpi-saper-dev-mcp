// git diff driver: an iFlow or message mapping as one fact per line, so `git diff` shows model changes
// (.gitattributes: *.iflw diff=cpi, *.mmap diff=cpi; git config diff.cpi.textconv "cpi-saper-dev-mcp textconv")
import { readFileSync } from 'node:fs';
import { describe, mappingText, parseIflw, readMapping, textconv } from '@cpi-saper-dev-mcp/core';

export function textconvFile(path: string): string {
  const text = readFileSync(path, 'utf8');
  // git passes a temp file without the original extension: recognise the format by content
  return /<xiObj[\s>]/.test(text.slice(0, 500)) ? mappingText(readMapping(text)) : textconv(describe(parseIflw(text), { maxLen: 0 }));
}
