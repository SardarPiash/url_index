import { UserError } from './errors.js';
import { parse } from 'csv-parse/sync';

export const states = ['SUBMITTED', 'DISCOVERY_ATTEMPTED', 'API_ACCEPTED', 'CRAWL_VERIFIED', 'INDEX_CONFIRMED', 'NOT_INDEXED', 'UNKNOWN', 'ERROR'] as const;
export const limitation = 'Baseline performs no network requests. Crawl and index status remain UNKNOWN until reliable evidence is collected. No comparison or speed claim is supported.';

export function normalizeUrl(input: string): string {
  const url = new URL(input.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new UserError('URLs must use HTTP(S) and must not contain credentials.');
  }
  url.hash = '';
  return url.href;
}

export function importUrls(args: string[], csv?: string): string[] {
  const values = [...args];
  if (csv !== undefined) {
    const rows: string[][] = parse(csv, { bom: true, skip_empty_lines: true, trim: true, max_record_size: 16384 });
    const header = rows.shift();
    if (!header || header.filter(value => value === 'url').length !== 1) throw new UserError('CSV requires exactly one url header.');
    const column = header.indexOf('url');
    for (const [index, row] of rows.entries()) {
      if (row.length !== header.length || !row[column]) throw new UserError(`Invalid CSV row ${index + 2}.`);
      values.push(row[column]!);
    }
  }
  if (!values.length) throw new UserError('Provide at least one URL or --csv file.');
  return [...new Set(values.map(normalizeUrl))];
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
