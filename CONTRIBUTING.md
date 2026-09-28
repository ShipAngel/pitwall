# Contributing

Thanks for helping. Pitwall is small on purpose, so please open an issue to talk
through anything bigger than a bug fix before writing it.

## Setup

```sh
npm ci
cp .env.local.example .env.local     # add a GitHub token and a Linear API key
cp config.example.json config.json   # list the repos you want to track
./start.sh
```

## Before you open a PR

Run the full gate. CI runs the same four steps and must be green:

```sh
npm run typecheck && npm test && npm run lint && npm run build
```

- **Logic goes in `src/lib/`, with its test beside it.** Routes and components
  stay thin. The layout is described in the README under Development.
- **Tests never hit the network.** Upstream responses are fixtures.
- **Break your new test on purpose once** and check it fails. Several tests here
  passed while asserting nothing until they were checked this way.
- **Anything that writes to GitHub or Linear** needs a deliberate button, never a
  side effect of a panel refreshing. Read the Start Work section of
  [`CLAUDE.md`](./CLAUDE.md) first.
- **Adding a setting** means updating `config.example.json`, `validateConfig` and
  the README reference table.
- **Don't run `npm audit fix`.** The README's Dependencies section explains why.

[`CLAUDE.md`](./CLAUDE.md) holds the design notes: the upstream API traps and the
reason behind each guard. It is worth reading before changing anything in the
area it covers.

## Reporting a security problem

Not in an issue, please. See [`SECURITY.md`](./SECURITY.md).
