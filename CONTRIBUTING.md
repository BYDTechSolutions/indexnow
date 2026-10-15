# Contributing

Thanks for helping. Issues and pull requests are welcome at
[github.com/BYDTechSolutions/indexnow](https://github.com/BYDTechSolutions/indexnow).

## Setup

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Node.js 20 or later.

## Rules

- Tests never reach the network: they run against a local `node:http` server, and
  `test/setup.ts` makes any request to another host fail. Never point a test, or a
  manual try-out, at a real IndexNow endpoint with a site you do not control; use
  `--dry-run`.
- Protocol behavior follows [indexnow.org/documentation](https://www.indexnow.org/documentation).
  If you change it, link the part of the documentation that supports the change.
- No runtime dependencies without a strong reason, stated in the README.
- Add a line to `CHANGELOG.md` under "Unreleased".
- American English in code, messages and docs.
