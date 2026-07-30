---
name: gitflow-jira
description: Gitflow branching rules, JIRA ticket workflow, and sprint-end release checklist for this project
---

## Gitflow Branching Strategy

This project follows **standard Gitflow**. Never deviate from these rules.

| Branch type | Cut from | Merges into | Naming |
|-------------|----------|-------------|--------|
| Feature | `develop` | `develop` | `KAN-XX-short-description` |
| Release | `develop` | `main` + `develop` | `release/X.Y.Z` |
| Hotfix | `main` | `main` + `develop` | `hotfix/short-description` |

- **`main`** — production only. Never commit or branch directly from it except for hotfixes.
- **`develop`** — integration branch. All feature PRs target this.
- **Features** — always cut from `develop`, always PR back into `develop`.
- **Sprint end** — a release branch is cut from `develop`, merged into `main`, then back into `develop`.
- **If unsure which branch to use — ask before creating the branch.**

---

## JIRA Workflow

- **Project key**: KAN
- **Branch naming**: `KAN-XX-short-description` (e.g. `KAN-45-today-screen-ui`)
- **Commit format**: `KAN-XX: short description` (e.g. `KAN-45: implement progress ring`)
- Linking a branch or PR with the ticket key in its name automatically closes the ticket when merged.

### Ticket Status Rules

| Event | Transition ticket to |
|-------|----------------------|
| Starting a ticket | **In Development** |
| PR opened and waiting for review / merge | **Testing** |
| PR merged into develop | **Concluído** |

- **Always** update the Jira ticket status at each of the three transitions above.
- Never leave a ticket in **A fazer** while actively working on it.
- Never leave a ticket in **In Development** after the PR has been opened.
- Never leave a ticket in **Testing** after the PR has been merged.

---

## Sprint Boundary Rule

### End-of-Sprint Checklist

When all tickets in a sprint are merged into `develop`, follow these steps **in order** before declaring the sprint done:

1. Cut a `release/X.Y.Z` branch from `develop`
2. Bump the version in `package.json`
3. PR the release branch into `main`, merge with `--admin` if needed
4. Tag the release on `main`: `git tag -a vX.Y.Z -m "Release vX.Y.Z"`
5. Push the tag: `git push origin vX.Y.Z`
6. **Create a GitHub release** on the tag with full release notes — group tickets by feature area, include setup/migration notes if relevant
7. Merge the release branch back into `develop`
8. Delete the release branch
9. Remove the full sprint detail section from CLAUDE.md and mark it as ✅ Done in the Sprint History list
10. Report to the user and wait for Sprint N+1 planning

**Never skip the GitHub release.** Release notes are required for every sprint — they are the handoff document for QA, stakeholders, and future contributors.
