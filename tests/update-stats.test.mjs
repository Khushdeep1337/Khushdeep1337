import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectStats, metric, refresh, renderStats } from '../scripts/update-stats.mjs';

const ACCOUNT = 'Khushdeep1337';
const FILES = ['assets/pip-boy.svg', 'assets/pip-boy-mobile.svg', 'README.md'];
const STATS = { commits: 5, additions: 14, deletions: 5, lines: 19, repos: 1 };
const repo = (name, extra = {}) => ({ name, private: false, fork: false, owner: { login: ACCOUNT }, ...extra });
const author = (login = ACCOUNT) => ({ author: { login }, total: 5, weeks: [{ a: 10, d: 3 }, { a: 4, d: 2 }] });
const response = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status });

async function workspace(t, contents) {
  const root = await mkdtemp(join(tmpdir(), 'pipboy-stats-'));
  await mkdir(join(root, 'assets'));
  await Promise.all(FILES.map((file, i) => writeFile(join(root, file), contents[i])));
  t.after(async () => {
    await Promise.all(FILES.map(file => unlink(join(root, file))));
    await rmdir(join(root, 'assets'));
    await rmdir(root);
  });
  return root;
}

test('paginates and excludes private, fork, other-owner, and other-author activity', async () => {
  const requests = [];
  const stats = await collectStats({ token: undefined, fetchImpl: async url => {
    requests.push(url);
    if (new URL(url).searchParams.get('page') === '1') return response(Array.from({ length: 100 }, (_, i) => repo(`fork-${i}`, { fork: true })));
    if (new URL(url).searchParams.get('page') === '2') return response([
      repo('project'), repo('secret', { private: true }), repo('organization', { owner: { login: 'a-team' } }),
    ]);
    assert.match(url, /\/project\/stats\/contributors$/);
    return response([author('another-user'), author(ACCOUNT.toUpperCase())]);
  } });
  assert.deepEqual(stats, { ...STATS, repos: 101 });
  assert.equal(requests.length, 3);
});

test('retries calculation responses and handles empty and unattributed repositories', async () => {
  let attempts = 0;
  const waits = [];
  const stats = await collectStats({ token: undefined, wait: async ms => waits.push(ms), fetchImpl: async url => {
    if (url.includes('/users/')) return response([repo('active'), repo('empty'), repo('unattributed')]);
    if (url.includes('/empty/')) return response(null, 204);
    if (url.includes('/unattributed/')) return response([author('another-user')]);
    return ++attempts === 1 ? response({}, 202) : response([author()]);
  } });
  assert.deepEqual(stats, { ...STATS, repos: 3 });
  assert.deepEqual(waits, [10_000]);
});

test('refreshes both real SVGs and accessible README text without touching other content', async t => {
  const originals = await Promise.all(FILES.map(file => readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
  const root = await workspace(t, originals);
  const stats = await refresh({ root, now: new Date('2026-11-04T05:00:00Z'), token: undefined,
    fetchImpl: async url => response(url.includes('/users/') ? [repo('project')] : [author()]),
  });
  assert.deepEqual(stats, STATS);
  const outputs = await Promise.all(FILES.map(file => readFile(join(root, file), 'utf8')));
  const stripStats = text => text
    .replace(/GitHub snapshot from \d{4}-\d{2}-\d{2}: [^"<]+?Merge and empty commits are excluded\./g, 'SUMMARY')
    .replace(/(<text id="stats-[^"]+"[^>]*>)[^<]*(<\/text>)/g, '$1VALUE$2')
    .replace(/<!-- STATS:START[\s\S]*?STATS:END -->/g, 'METADATA');
  outputs.forEach((output, i) => {
    assert.match(output, /GitHub snapshot from 2026-11-03: 5 authored commits and 19 lines changed/);
    assert.equal(stripStats(output), stripStats(originals[i]));
  });
  for (const svg of outputs.slice(0, 2)) {
    assert.match(svg, /id="stats-commits"[^>]*>5<\/text>/);
    assert.match(svg, /id="stats-lines"[^>]*>19<\/text>/);
    assert.match(svg, /id="stats-repos"[^>]*>1<\/text>/);
    assert.match(svg, /id="stats-updated"[^>]*>[^<]*2026-11-03<\/text>/);
  }
});

for (const failure of ['HTTP error', 'calculation timeout', 'missing template marker']) {
  test(`${failure} keeps every existing file`, async t => {
    const originals = await Promise.all(FILES.map(file => readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
    if (failure === 'missing template marker') originals[1] = originals[1].replace('id="stats-lines"', 'id="missing"');
    const root = await workspace(t, originals);
    let attempts = 0;
    await assert.rejects(refresh({ root, token: undefined, wait: async () => {}, fetchImpl: async url => {
      if (url.includes('/users/')) return response([repo('project')]);
      attempts++;
      if (failure === 'HTTP error') return response({}, 403);
      if (failure === 'calculation timeout') return response({}, 202);
      return response([author()]);
    } }), /HTTP 403|still calculating|Missing or duplicate/);
    if (failure === 'calculation timeout') assert.equal(attempts, 6);
    assert.deepEqual(await Promise.all(FILES.map(file => readFile(join(root, file), 'utf8'))), originals);
  });
}

test('rejects malformed counts and unsupported line statistics', async () => {
  for (const contributor of [{ ...author(), total: 10_000 }, { ...author(), weeks: [{ a: -1, d: 0 }] }]) {
    await assert.rejects(collectStats({ token: undefined, fetchImpl: async url =>
      response(url.includes('/users/') ? [repo('project')] : [contributor]),
    }), /unsupported|invalid activity count/);
  }
});

test('formats large values to fit the screen and rejects inconsistent rendered totals', () => {
  assert.equal(metric(39_013), '39,013');
  assert.equal(metric(123_456), '123.5K');
  assert.throws(() => renderStats('', { ...STATS, lines: 20 }, '2026-11-03'), /do not match/);
});
