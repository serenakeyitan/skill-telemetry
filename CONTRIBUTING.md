# Contributing to skill-telemetry

Thanks for the interest. This project is small, focused, and prefers
**low-friction PRs** over long design discussions.

## Quick start

```bash
git clone https://github.com/serenakeyitan/skill-telemetry
cd skill-telemetry

# Run the smoke tests (10 invariants, ~2s on a warm machine)
./tests/smoke.sh

# Try the dashboard locally
cd dashboard && npm run demo
# → http://localhost:8787/?demo=1
```

If smoke tests pass and `node --check dashboard/worker.js` passes, you
have a working setup.

## What goes where

- `bin/` — shell scripts users actually run (telemetry-log, telemetry-sync,
  telemetry-hook, skill-events, etc.). Each opens with a doc comment
  explaining *why* it exists, not just *what*. Match that style.
- `dashboard/` — the worker.js (Cloudflare) + local.js (Node) UI. Both
  import the same render functions from `worker.js`.
- `supabase/` — schema, edge function, RLS policies.
- `skills/add-telemetry/` — the meta-skill (Claude Code skill) that
  onboards skill authors.
- `tests/smoke.sh` — end-to-end assertions. Every audit finding has
  a regression test here. Add one when you fix a bug.

## Filing issues

- **Bugs**: include the platform (macOS / Linux / Alpine), shell
  (bash / zsh), Node version, and the exact command. Paste the
  output between `````` triple backticks ``````.
- **Feature requests**: explain the user problem first, propose a
  solution second.
- **Security**: please email rather than opening a public issue.

## Filing PRs

- Run `./tests/smoke.sh` before pushing. CI runs it too, but local
  feedback is faster.
- One concern per PR. A "drive-by improvements" PR that also fixes
  three other things is harder to review.
- Match the existing style: comments explain *why*, function names
  read like English, no premature abstractions.
- For shell scripts: `bash -n <file>` must pass. `shellcheck -S error`
  must pass (warnings are OK).
- For JavaScript: `node --check <file>` must pass.

## What kind of contributions we'd love

- **Bug reports with reproductions.** Even better: a failing smoke
  test that reproduces the bug.
- **Portability fixes** for shells, distros, or Node versions we
  don't run on (Alpine + musl, Windows under WSL, NixOS, etc).
- **Dashboard improvements** — more chart types, better mobile layout,
  accessibility (ARIA, keyboard nav).
- **Translations** of the meta-skill into other languages.

## What we'll probably push back on

- Big architectural rewrites without a discussion issue first.
- Adding heavy dependencies (this project deliberately has near-zero
  deps).
- Changes that complicate the privacy story.

## Code of conduct

Be kind. We're a small project; one rude reply pollutes the whole
thing. If you wouldn't say it in person, don't post it here.

## License

By contributing, you agree your work will be released under the same
[MIT license](./LICENSE) as the project.
