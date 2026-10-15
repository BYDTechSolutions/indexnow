# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-16

### Added

- `indexnow submit`: send URLs or paths, a sitemap (sitemap index files and gzip included) or a list on stdin; de-duplicates, rejects URLs on another host, checks the key file first, batches at 10,000 URLs, and supports `--dry-run`.
- `indexnow verify`: check that the site serves the key file.
- `indexnow key`: generate a key and write `<key>.txt`, refusing to replace a different key without `--force`.
- A plain-language message for each IndexNow response code, and exit codes 0, 1 and 2.
- API: `submit`, `prepareSubmission`, `readSitemap`, `parseSitemap`, `generateKey`, `findKey`, `writeKeyFile`, `verifyKey`, `isValidKey`, `describeStatus`.

[Unreleased]: https://github.com/BYDTechSolutions/indexnow/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BYDTechSolutions/indexnow/releases/tag/v0.1.0
