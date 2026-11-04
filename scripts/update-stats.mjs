import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ACCOUNT = 'Khushdeep1337';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FILES = ['assets/pip-boy.svg', 'assets/pip-boy-mobile.svg', 'README.md'];
const SUMMARY = /GitHub snapshot from \d{4}-\d{2}-\d{2}: [^"<]+?Merge and empty commits are excluded\./g;

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('GitHub returned an invalid activity count.');
  }
  return value;
}

export function metric(value) {
  return new Intl.NumberFormat('en-US', {
    notation: value >= 100_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(count(value));
}

export async function collectStats({
  fetchImpl = fetch,
  wait = delay,
  token = process.env.GITHUB_TOKEN,
} = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': `${ACCOUNT}-profile-stats`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function get(path) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        headers,
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
      });
      if (response.status === 202) {
        if (attempt === 5) break;
        await wait(10_000);
        continue;
      }
      if (response.status === 204) return [];
      if (response.status !== 200) {
        throw new Error(`GitHub returned HTTP ${response.status} for ${path}.`);
      }
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error(`Expected an array from ${path}.`);
      return data;
    }
    throw new Error(`GitHub is still calculating ${path}; keeping the previous snapshot.`);
  }

  const repos = [];
  // ponytail: cap pagination at 5,000 repos; raise this ceiling if the account reaches it.
  for (let page = 1; page <= 50; page++) {
    const batch = await get(`/users/${ACCOUNT}/repos?type=owner&per_page=100&page=${page}`);
    for (const repo of batch) {
      if (typeof repo.private !== 'boolean' || typeof repo.fork !== 'boolean'
          || typeof repo.owner?.login !== 'string' || typeof repo.name !== 'string'
          || !/^[\w.-]+$/.test(repo.name)) {
        throw new Error('GitHub returned an invalid repository record.');
      }
      if (!repo.private && repo.owner.login.toLowerCase() === ACCOUNT.toLowerCase()) {
        repos.push(repo);
      }
    }
    if (batch.length < 100) break;
    if (page === 50) throw new Error('Repository pagination limit reached; snapshot kept.');
  }

  const stats = { commits: 0, additions: 0, deletions: 0, repos: repos.length };
  const originals = repos.filter(repo => !repo.fork);
  for (let start = 0; start < originals.length; start += 4) {
    const batch = await Promise.all(originals.slice(start, start + 4).map(async repo => {
      const contributors = await get(`/repos/${ACCOUNT}/${encodeURIComponent(repo.name)}/stats/contributors`);
      const totalCommits = contributors.reduce((total, author) => count(total + count(author.total)), 0);
      // GitHub returns zero line counts at this limit; do not publish those as real data.
      if (totalCommits >= 10_000) {
        throw new Error(`Line statistics are unsupported for ${repo.name} (10,000+ commits).`);
      }
      const author = contributors.find(item => item.author?.login?.toLowerCase() === ACCOUNT.toLowerCase());
      if (!author) return { commits: 0, additions: 0, deletions: 0 };
      if (!Array.isArray(author.weeks)) throw new Error(`Missing weekly statistics for ${repo.name}.`);
      return author.weeks.reduce((total, week) => ({
        commits: total.commits,
        additions: count(total.additions + count(week.a)),
        deletions: count(total.deletions + count(week.d)),
      }), { commits: count(author.total), additions: 0, deletions: 0 });
    }));
    for (const repo of batch) {
      stats.commits = count(stats.commits + repo.commits);
      stats.additions = count(stats.additions + repo.additions);
      stats.deletions = count(stats.deletions + repo.deletions);
    }
  }
  return { ...stats, lines: count(stats.additions + stats.deletions) };
}

function replaceOnce(text, pattern, replacement) {
  if ([...text.matchAll(pattern)].length !== 1) {
    throw new Error(`Missing or duplicate stats marker: ${pattern.source}`);
  }
  return text.replace(pattern, replacement);
}

export function renderStats(text, stats, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid snapshot date.');
  for (const key of ['commits', 'additions', 'deletions', 'lines', 'repos']) count(stats[key]);
  if (stats.lines !== stats.additions + stats.deletions) throw new Error('Line totals do not match.');
  const number = value => value.toLocaleString('en-US');
  const summary = `GitHub snapshot from ${date}: ${number(stats.commits)} authored commits and `
    + `${number(stats.lines)} lines changed (additions plus deletions) across default branches of `
    + `owned public non-fork repositories; ${number(stats.repos)} public repositories overall. `
    + 'Merge and empty commits are excluded.';
  let output = replaceOnce(text, SUMMARY, summary);

  if (text.startsWith('<svg')) {
    for (const [id, value] of [['commits', stats.commits], ['lines', stats.lines], ['repos', stats.repos]]) {
      output = replaceOnce(output, new RegExp(`(<text id="stats-${id}"[^>]*>)[^<]*(</text>)`, 'g'),
        (_, open, close) => `${open}${metric(value)}${close}`);
    }
    return replaceOnce(output, /(<text id="stats-updated"[^>]*>[^<]*?)\d{4}-\d{2}-\d{2}(<\/text>)/g,
      (_, prefix, close) => `${prefix}${date}${close}`);
  }

  return replaceOnce(output, /<!-- STATS:START[\s\S]*?STATS:END -->/g,
    `<!-- STATS:START\nGenerated by scripts/update-stats.mjs. Updated ${date} (Etc/GMT+7).\n`
    + `Source: /users/${ACCOUNT}/repos and /repos/${ACCOUNT}/{repo}/stats/contributors.\n`
    + `${number(stats.commits)} commits; ${number(stats.additions)} additions + `
    + `${number(stats.deletions)} deletions = ${number(stats.lines)} lines changed.\n`
    + 'Scope: owned public non-fork default branches, attributed to this GitHub login.\n'
    + 'Per-repository totals; private, organization-owned, and fork activity is excluded.\nSTATS:END -->');
}

export async function refresh({ root = ROOT, now = new Date(), ...options } = {}) {
  const stats = await collectStats(options);
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Etc/GMT+7', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  // Fetch and render every file before writing, so API or template errors preserve the snapshot.
  const updates = await Promise.all(FILES.map(async file => {
    const path = join(root, file);
    return { path, text: renderStats(await readFile(path, 'utf8'), stats, date) };
  }));
  await Promise.all(updates.map(file => writeFile(file.path, file.text, 'utf8')));
  return stats;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const stats = await refresh();
    console.log(`Updated: ${stats.commits} commits, ${stats.lines} lines changed, ${stats.repos} public repos.`);
  } catch (error) {
    console.error(`Stats refresh failed: ${error.message}`);
    process.exitCode = 1;
  }
}
