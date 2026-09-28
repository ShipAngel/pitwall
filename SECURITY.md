# Security

## Reporting a problem

Please report security issues privately, through GitHub's **Report a
vulnerability** button on this repo's Security tab. Don't open a public issue.

## What Pitwall is, and what that means

Pitwall is a single-user dashboard that runs on your own machine. It holds your
GitHub token and Linear API key, and it can act on them and on your computer:

- **Start Work** creates a branch, a draft PR and a Linear status change.
- **Per-PR terminals** (off by default) run a shell in a git worktree, and
  ending one can delete that worktree.
- **The Sessions panel** can bring an iTerm2 window to the front.

So it has no login, and it relies on these boundaries instead:

- The dashboard (port 3737) and the terminal server (port 3738) listen on
  `127.0.0.1` only.
- Every request must be addressed to `localhost` or `127.0.0.1`. Anything else
  gets a 403 before it reaches a page or route, which stops a website from using
  DNS rebinding to reach the dashboard through your browser.
- Routes that change anything are POST-only and refuse cross-origin requests.
- The terminal server checks the `Origin` header and a per-boot token, and the
  browser only ever sends identifiers, never paths or commands.

**Never expose either port** to a network, a tunnel or a reverse proxy, and never
host Pitwall for other people. Anything that gets past those boundaries is a
security issue and worth reporting.
