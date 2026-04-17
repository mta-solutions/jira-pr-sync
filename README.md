# jira-pr-sync

Automated GitHub PR ↔ Jira task lifecycle sync used across all `mta-solutions` repositories.

## How it works

Each repo has a thin GitHub Actions workflow (`.github/workflows/jira-pr-sync.yml`) that checks out this repo and runs `index.js`.

| PR Event | Jira Action |
|---|---|
| PR title contains `[PROJ-123]` | Creates a new task and links it to the existing Jira issue |
| PR title contains `[PROJ]` | Uses `PROJ` as the Jira project key (overrides label) |
| PR labeled with `jira:PROJ` | Creates a Task in project `PROJ`, assigns to PR author |
| PR review submitted | Creates a linked Task (labeled `pr-review`) for the review, assigns to reviewer |
| PR review dismissed | Closes the review's Jira task |
| PR merged | Transitions parent Jira task to **Done** |
| PR closed (no merge) | Transitions parent Jira task to **Canceled** |

## User mapping

`jira-users.json` in this repo maps GitHub usernames to Jira emails for assignment.

Repos can override this by placing their own `.github/jira-users.json` — the local copy takes priority.

## Required org secrets

| Secret | Description |
|---|---|
| `JIRA_BASE_URL` | e.g. `https://mta-telco.atlassian.net` |
| `JIRA_USER_EMAIL` | Atlassian account email for API access |
| `JIRA_API_TOKEN` | [API token](https://id.atlassian.com/manage-profile/security/api-tokens) for that account |
