# Profile stats

Requires Node.js 24. No packages or personal access token are needed.

Refresh locally:

```sh
node --test tests/update-stats.test.mjs
node scripts/update-stats.mjs
```

The updater fetches public GitHub activity and updates the desktop SVG, mobile
SVG, and README alt text together. It leaves commits to you. An optional
`GITHUB_TOKEN` environment variable increases the API rate limit; never put a
token in a repository file.

## Daily refresh

The workflow is prepared but publishing is **opt-in**, respecting this
repository's rule that the owner manages commits.

After committing and pushing this setup to the default branch, create an
Actions repository variable named `AUTO_UPDATE_STATS` with value `true` under
**Settings → Secrets and variables → Actions → Variables**. This explicitly
enables automated stats commits. The workflow runs daily at 09:37 UTC (02:37
in the configured UTC−7 timezone), or through **Actions → Refresh profile
stats → Run workflow**. Remove the variable to disable publishing.

Only the three generated profile files are committed. The built-in
`GITHUB_TOKEN` is sufficient; branch protection may require an adjustment if
direct automated pushes are blocked. This setup has not been published or
enabled by Codex.

## What the numbers mean

- **Authored commits:** commits GitHub attributes to `Khushdeep1337` on the
  default branches of owned public repositories, excluding forks.
- **Lines changed:** additions plus deletions in that same scope.
- **Public repos:** all owned public repositories, including forks.

Private repositories and organization-owned projects (including the Canvas
project) are excluded. These are per-repository totals, so copied histories
can appear in more than one repository. Merge and empty commits are excluded
by GitHub's contributor statistics. Automated bot commits do not count as
your authored commits.

The displayed date uses `Etc/GMT+7`. Numbers refresh daily, rather than on
each page view. GitHub caches contributor statistics and sometimes responds
with `202` while calculating them. The updater retries, then fails without
replacing the previous snapshot if any API response or stats marker is
incomplete. GitHub does not supply reliable line counts for repositories
with 10,000 or more commits; the updater rejects detected cases instead of
publishing zeros.

Source: [GitHub repository statistics API](https://docs.github.com/en/rest/metrics/statistics#get-all-contributor-commit-activity).
