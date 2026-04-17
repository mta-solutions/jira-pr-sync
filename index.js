module.exports = async ({ github, context, core }) => {
  const fs = require('fs');
  const path = require('path');

  // ── Config ──────────────────────────────────────────
  const JIRA_BASE   = process.env.JIRA_BASE_URL.replace(/\/$/, '');
  const JIRA_EMAIL  = process.env.JIRA_USER_EMAIL;
  const JIRA_TOKEN  = process.env.JIRA_API_TOKEN;
  const AUTH_HEADER = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

  // User mapping — check local repo override first, then fall back to this repo's copy
  let userMap = {};
  const localPath = path.join(process.env.GITHUB_WORKSPACE, '.github', 'jira-users.json');
  const bundledPath = path.join(__dirname, 'jira-users.json');
  const mapPath = fs.existsSync(localPath) ? localPath : bundledPath;
  try {
    userMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    core.info(`Loaded user mapping from ${mapPath === localPath ? 'repo .github/jira-users.json' : 'central jira-users.json'}`);
  } catch (e) {
    core.warning('No jira-users.json found — Jira assignments will be skipped');
  }

  // ── Helpers ─────────────────────────────────────────
  async function jiraApi(method, apiPath, body) {
    const resp = await fetch(`${JIRA_BASE}/rest/api/3${apiPath}`, {
      method,
      headers: {
        'Authorization': AUTH_HEADER,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`Jira API ${method} ${apiPath} → ${resp.status}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async function findJiraAccountId(githubUser) {
    const email = userMap[githubUser];
    if (!email) return null;
    try {
      const users = await jiraApi('GET', `/user/search?query=${encodeURIComponent(email)}`);
      return users.length > 0 ? users[0].accountId : null;
    } catch (e) {
      core.warning(`Could not resolve Jira user for ${githubUser}: ${e.message}`);
      return null;
    }
  }

  const DEFAULT_PROJECT_KEY = 'SOF';

  function extractIssueKeyFromTitle(title) {
    const match = title.match(/\[([A-Z][A-Z0-9]*-\d+)\]/);
    return match ? match[1] : null;
  }

  function extractProjectKeyFromTitle(title) {
    const match = title.match(/\[([A-Z][A-Z0-9]+)\]/);
    return match ? match[1] : null;
  }

  function getJiraProjectKey(title, labels) {
    // 1. [PROJ-123] in title → derive project  2. [PROJ] in title  3. jira:PROJ label  4. default SOF
    const issueKey = extractIssueKeyFromTitle(title);
    if (issueKey) return issueKey.split('-')[0];
    const titleKey = extractProjectKeyFromTitle(title);
    if (titleKey) return titleKey;
    for (const label of labels) {
      const match = label.name.match(/^jira:([A-Z][A-Z0-9]+)$/);
      if (match) return match[1];
    }
    return DEFAULT_PROJECT_KEY;
  }

  async function jiraIssueExists(issueKey) {
    try {
      await jiraApi('GET', `/issue/${issueKey}?fields=summary`);
      return true;
    } catch {
      return false;
    }
  }

  async function findLinkedIssueKey(prNumber) {
    const comments = await github.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
    });
    for (const c of comments.data) {
      const match = c.body.match(/<!-- jira-pr-sync:parent=([A-Z]+-\d+) -->/);
      if (match) return match[1];
    }
    return null;
  }

  async function transitionIssue(issueKey, targetName) {
    const { transitions } = await jiraApi('GET', `/issue/${issueKey}/transitions`);
    const target = transitions.find(t => t.name.toLowerCase() === targetName.toLowerCase());
    if (!target) {
      core.warning(`Transition "${targetName}" not found for ${issueKey}. Available: ${transitions.map(t => t.name).join(', ')}`);
      return;
    }
    await jiraApi('POST', `/issue/${issueKey}/transitions`, { transition: { id: target.id } });
    core.info(`Transitioned ${issueKey} → ${targetName}`);
  }

  // ── Main logic ──────────────────────────────────────
  const event = context.eventName;
  const action = context.payload.action;
  const pr = context.payload.pull_request;

  // ▸ PR opened or labeled with jira:PROJ → create Jira task
  if (event === 'pull_request' && (action === 'opened' || action === 'labeled')) {
    const projectKey = getJiraProjectKey(pr.title, pr.labels);

    const existing = await findLinkedIssueKey(pr.number);
    if (existing) {
      core.info(`Already linked to ${existing} — skipping creation`);
      return;
    }

    const titleIssueKey = extractIssueKeyFromTitle(pr.title);
    const assigneeId = await findJiraAccountId(pr.user.login);

    const issue = await jiraApi('POST', '/issue', {
      fields: {
        project: { key: projectKey },
        summary: `[PR] ${pr.title}`,
        description: {
          type: 'doc',
          version: 1,
          content: [{
            type: 'paragraph',
            content: [{
              type: 'text',
              text: `GitHub PR: ${pr.html_url}\n\nRepository: ${context.repo.owner}/${context.repo.repo}\nAuthor: ${pr.user.login}`,
            }],
          }],
        },
        issuetype: { name: 'Task' },
        ...(assigneeId && { assignee: { accountId: assigneeId } }),
      },
    });

    core.info(`Created Jira issue: ${issue.key}`);

    await jiraApi('POST', `/issue/${issue.key}/comment`, {
      body: {
        type: 'doc',
        version: 1,
        content: [{
          type: 'paragraph',
          content: [
            { type: 'text', text: '🔗 GitHub Pull Request: ' },
            { type: 'text', text: `${context.repo.owner}/${context.repo.repo}#${pr.number}`, marks: [{ type: 'link', attrs: { href: pr.html_url } }] },
          ],
        }],
      },
    });

    await transitionIssue(issue.key, 'In Progress');

    // If PR title references an existing Jira issue, link the new task to it
    if (titleIssueKey && await jiraIssueExists(titleIssueKey)) {
      await jiraApi('POST', '/issueLink', {
        type: { name: 'Relates' },
        inwardIssue: { key: titleIssueKey },
        outwardIssue: { key: issue.key },
      });
      core.info(`Linked ${issue.key} to existing issue ${titleIssueKey}`);
    }

    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pr.number,
      body: `<!-- jira-pr-sync:parent=${issue.key} -->\n🔗 Jira task created: [${issue.key}](${JIRA_BASE}/browse/${issue.key})`,
    });
  }

  // ▸ PR closed → transition Jira task to Done or Canceled
  if (event === 'pull_request' && action === 'closed') {
    const issueKey = await findLinkedIssueKey(pr.number);
    if (!issueKey) {
      core.info('No linked Jira issue found — skipping');
      return;
    }

    if (pr.merged) {
      await transitionIssue(issueKey, 'Done');
      core.info(`PR merged — transitioned ${issueKey} to Done`);
    } else {
      try {
        await transitionIssue(issueKey, 'Canceled');
      } catch {
        await transitionIssue(issueKey, 'Done');
      }
      core.info(`PR closed without merge — transitioned ${issueKey} to Canceled`);
    }
  }

  // ▸ PR review submitted → create linked review issue
  if (event === 'pull_request_review' && action === 'submitted') {
    const review = context.payload.review;
    const prNumber = pr.number;

    const issueKey = await findLinkedIssueKey(prNumber);
    if (!issueKey) {
      core.info('No linked Jira parent issue — skipping review tracking');
      return;
    }

    const projectKey = issueKey.split('-')[0];
    const reviewerAccountId = await findJiraAccountId(review.user.login);

    const stateLabel = {
      approved: '✅ Approved',
      changes_requested: '🔄 Changes Requested',
      commented: '💬 Commented',
    }[review.state] || review.state;

    const reviewIssue = await jiraApi('POST', '/issue', {
      fields: {
        project: { key: projectKey },
        summary: `[Review] ${stateLabel} by ${review.user.login} on PR #${prNumber}`,
        description: {
          type: 'doc',
          version: 1,
          content: [{
            type: 'paragraph',
            content: [{
              type: 'text',
              text: `Review: ${review.html_url}\nParent PR: ${pr.html_url}\nState: ${review.state}`,
            }],
          }],
        },
        issuetype: { name: 'Task' },
        labels: ['pr-review'],
        ...(reviewerAccountId && { assignee: { accountId: reviewerAccountId } }),
      },
    });

    await jiraApi('POST', '/issueLink', {
      type: { name: 'Relates' },
      inwardIssue: { key: issueKey },
      outwardIssue: { key: reviewIssue.key },
    });

    core.info(`Created review issue ${reviewIssue.key} linked to ${issueKey}`);

    await jiraApi('POST', `/issue/${reviewIssue.key}/comment`, {
      body: {
        type: 'doc',
        version: 1,
        content: [{
          type: 'paragraph',
          content: [
            { type: 'text', text: '🔗 GitHub Review: ' },
            { type: 'text', text: `${review.user.login}'s review on PR #${pr.number}`, marks: [{ type: 'link', attrs: { href: review.html_url } }] },
          ],
        }],
      },
    });

    if (review.state === 'approved') {
      await transitionIssue(reviewIssue.key, 'Done');
    }
  }

  // ▸ PR review dismissed → find and close the review issue
  if (event === 'pull_request_review' && action === 'dismissed') {
    const review = context.payload.review;
    const prNumber = pr.number;

    const issueKey = await findLinkedIssueKey(prNumber);
    if (!issueKey) return;

    const projectKey = issueKey.split('-')[0];

    const jql = `project = ${projectKey} AND summary ~ "[Review]" AND summary ~ "${review.user.login}" AND summary ~ "PR #${prNumber}" AND statusCategory != Done`;
    try {
      const results = await jiraApi('GET', `/search?jql=${encodeURIComponent(jql)}&maxResults=5`);
      for (const issue of results.issues || []) {
        await transitionIssue(issue.key, 'Done');
        core.info(`Dismissed review — transitioned ${issue.key} to Done`);
      }
    } catch (e) {
      core.warning(`Could not find/close review issue: ${e.message}`);
    }
  }
};
