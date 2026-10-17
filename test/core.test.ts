import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importUrls, median, csvCell } from '../src/core.js';

test('imports quoted CSV and deduplicates normalized URLs', () => {
  assert.deepEqual(importUrls(['https://example.com/a#one'], '\ufeffurl,label\r\nhttps://example.com/a#two,control\r\n"https://example.com/b?x=1,2",test\r\n'), ['https://example.com/a', 'https://example.com/b?x=1,2']);
});
test('rejects empty, malformed and credential-bearing imports atomically', () => {
  for (const run of [() => importUrls([]), () => importUrls([], 'target\nhttps://example.com'), () => importUrls([], 'url\n\n'), () => importUrls(['file:///etc/passwd']), () => importUrls(['https://user:secret@example.com']), () => importUrls(['https://example.com', 'bad'])]) assert.throws(run);
});
test('median has no fabricated zero when no evidence exists', () => {
  assert.equal(median([]), null);
  assert.equal(median([9, 1, 4]), 4);
  assert.equal(median([8, 2]), 5);
});
test('CSV escapes quotes, newlines and spreadsheet formulas', () => {
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell(null), '""');
});
