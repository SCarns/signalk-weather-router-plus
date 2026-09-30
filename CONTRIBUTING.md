# Contributing

Contributions are welcome: bug reports, fixes, new features, data
sources, documentation.

## Licence of contributions

This project is licensed under the [Apache License 2.0](LICENSE). Under
section 5 of that licence, anything you submit for inclusion (a pull
request, a patch, a suggested change in an issue) is licensed under the
same Apache License 2.0, unless you say otherwise in writing when you
submit it. By submitting you confirm that you have the right to
contribute it under those terms: it is your own work, or you have
permission to contribute it, and it carries no terms that conflict with
the Apache License 2.0.

Third-party code or data in a contribution must say where it comes from
and its licence, and that licence must allow it to be distributed under
the Apache License 2.0; add its attribution to [NOTICE](NOTICE).

## Name

Forking is welcome. The Apache License does not grant use of the names
"Weather Router Plus" or "signalk-weather-router-plus", or of the
project's icons (section 6). A modified version that you publish, for
example on npm or in the Signal K App Store, must use a different name
and icon, and must not suggest it is this project or endorsed by it. You
may say that it is based on Weather Router Plus.

## Before opening a pull request

- Branch from `main`.
- `npm ci`, then `npm run typecheck`, `npm run ci` (formatting check and
  lint), `npm test` and `npm run build`. The pull-request checks run the
  same (tests and build on Linux, macOS, Windows, arm64 and armv7, Node
  20–24) and must pass. `npm run format` fixes formatting.
- Add or update tests for what you change.
- Keep values SI in the API and in stored settings; the web app converts
  to the Signal K user's unit preferences for display.
- Update README.md (behaviour, API, settings) and CHANGELOG.md
  (`[Unreleased]`) where your change is visible to users or API clients.
