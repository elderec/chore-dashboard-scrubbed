# CLAUDE.md

Guidance for Claude Code (or any agent) working in this repo. See `README.md` for
full user-facing docs on chores, the overdue logic, the Worker API, and Fully Kiosk
setup — this file is about working _on_ the codebase, not using the dashboard.

## What this is

A Cloudflare Worker (TypeScript, Workers Static Assets) that serves a single-page
kiosk frontend and a small API backed by Todoist, for a wall-mounted tablet showing
a configurable set of kids' chores (currently Alex/Sam/Taylor — see `KIDS` in
`wrangler.toml`). No framework, no build step for the frontend, no database —
Todoist is the only source of truth for the chores themselves. A KV namespace
(`FAILURE_STATE`) holds derived app state — failure/heartbeat tracking, digest
completion counts, streak history — never a second copy of chore data itself;
if Todoist and the dashboard ever disagree, Todoist is right.

- `src/index.ts` — Worker entry point: auth check, routing, request handlers,
  the nightly digest, the streak feature, and the auto chore skip (rain-aware +
  calendar/no-school-aware, one shared engine) (all state-carrying logic lives
  here; `FAILURE_STATE` is this file's one KV binding, used for more than its
  name suggests — see the Conventions entry for it).
- `src/todoist.ts` — Todoist API client (base URL, task fetch/close/reopen,
  pagination).
- `src/overdue.ts` — timezone-aware due-date/overdue logic, pure functions, no I/O.
- `src/telegram.ts` — Telegram Bot API client, used for completion notifications,
  the nightly digest, and consecutive-failure alerts (all optional, all in `index.ts`).
- `src/weather.ts` — Open-Meteo daily-forecast client (precipitation, snowfall,
  weather code), used by the optional rain-aware chore skip and the snow-day
  reminder in `index.ts`. Tiny standalone module like `telegram.ts` — no auth,
  its own error handling.
- `src/schoolcalendar.ts` — loads the committed no-school date set
  (`public/school-calendar.json`, or `SCHOOL_SKIP_CALENDAR_URL`) for the
  calendar-aware chore skip; fails open (empty calendar, logged) on any error.
  The Worker never parses ICS itself — see `scripts/refresh-school-calendar.mjs`.
- `public/index.html` / `public/style.css` / `public/app.js` — the entire
  frontend, split out of one inline file for editability (see Conventions
  below) but still served exactly as-is by Workers Static Assets, no build
  step and no assets outside `public/`.
- `test/*.test.ts` / `e2e/*.spec.ts` — backend unit tests (Vitest, mocked
  `fetch`) and frontend e2e tests (Playwright, against a plain static server,
  mocked network) respectively — see Local dev / verification and Conventions
  below for how each runs.
- `scripts/bulk-reschedule-tasks.mjs` — a standalone Node script for safely
  bulk-rescheduling real chore data; see Bulk-editing real chore data below.
- `scripts/refresh-school-calendar.mjs` — a standalone Node script that
  regenerates `public/school-calendar.json` from your school district's
  public iCal feed (`No School - …` all-day events). Run to seed / once a year /
  after a snow make-up day; output is reviewed via `git diff`. No deps, no
  credentials. See the `SCHOOL_SKIP_*` Conventions entry.

## Hard constraints — don't relax these

- **Never** put `TODOIST_TOKEN` or `DASH_SECRET` in `wrangler.toml`, source, or
  commit them anywhere. They're `wrangler secret put` only. `.dev.vars` is
  gitignored — keep it that way.
- The Worker must only ever read/write tasks inside `KIDS_PROJECT_ID` (the
  **📋 Chore Chart** project). `getOwnedTask` in `src/index.ts` re-fetches and checks
  `project_id` before every write — don't remove that check or trust a task ID
  without it. This is the whole point of not giving the tablet direct Todoist
  credentials: a leaked dashboard URL should never be able to touch the rest of the
  Todoist account (including the separate, unrelated **✅ Chores** project).
- Every `/api/*` request must be gated by `?key=<DASH_SECRET>` — check this first in
  the `fetch` handler, before touching Todoist.
- Kid identity is determined **only** by Todoist labels matching the configured
  `KIDS` var (`parseKids()` in `src/index.ts`), not by task assignee. Don't
  reintroduce assignee-based logic, and don't hardcode a kid name anywhere in
  `src/` or `public/` — `KIDS` is the single source of truth, and the
  frontend builds its columns dynamically from the `/api/chores` response's `kids`
  list rather than having any name baked into the markup. This is also
  exactly why avatar photos are served through an authenticated route backed
  by R2 rather than a plain `public/` file — see the `AVATARS` Conventions
  entry below.
- `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` get the same treatment as the other two
  secrets — `wrangler secret put` only, never in `wrangler.toml`/source. Both are
  optional (`notifyTelegram` no-ops if either is unset), and a Telegram failure must
  never turn a successful `complete`/`reopen` into an error response — it's caught
  and logged in `notifyTelegram`, not propagated. Don't change that to a throw. The
  same "catch, log, never throw" rule applies to `runDailyDigest` — it runs from a
  `scheduled` cron handler with nothing waiting on a response.

## Todoist API gotchas (hit these before, don't regress)

Todoist's REST API v2 (`api.todoist.com/rest/v2/...`) is fully retired — it now
returns `410 Gone`. This project uses their unified `/api/v1/` API
(`api.todoist.com/api/v1/...`), which differs in ways that matter here:

- The task list endpoint (`GET /tasks`) returns `{ results: [...], next_cursor }`,
  not a bare array — `getProjectTasks` in `src/todoist.ts` pages through this.
- `GET /tasks/{id}` and the `close`/`reopen` POST endpoints are unchanged in shape
  (raw task object / `204 No Content` respectively).
- The `due` object has **no** separate `datetime` field like v2 did. Only
  `due.date` (either `"YYYY-MM-DD"` or a naive local datetime string with no
  offset, e.g. `"2026-08-22T09:00:00"`) and `due.timezone` (an IANA zone name, or
  `null` for date-only / floating times). `src/overdue.ts` does its own
  offset-conversion (`zonedWallTimeToInstant`) to turn that into a real UTC instant
  — if you touch this file, keep that conversion, don't assume a ready-made UTC
  field exists.

If Todoist changes their API again, `overdue.ts`'s two Intl-based helpers
(`timeZoneOffsetMinutes`, `zonedWallTimeToInstant`) are the place a timezone bug
would show up — `test/overdue.test.ts` covers date-only vs. timed due dates and
floating vs. explicit-zone times, so a regression there should fail loudly; add a
case rather than spot-checking by hand if you touch this file.

**Changing a recurring task's interval on an _existing_ task via `due_string` is
unreliable — confirmed by directly breaking two real chores this way.** Sending
an update whose `due_string` changes the recurrence _interval_ (e.g. "every other
day" → "every 3 days"), not just the time-of-day, produced two different bad
outcomes depending on whether `starting <date>` was included:

- **With `starting <date>`**: the due date was wiped entirely (`due: null`,
  `is_recurring: false`) — the task silently lost its schedule.
- **Without `starting`**: the update appeared to succeed, but Todoist silently
  ignored the requested new interval and kept the task's _old_ one.

Changing only the _time-of-day_ on an existing recurring task (same interval,
new `due_string` with `starting <its own current date>`) — the pattern this
project uses everywhere else, including `rescheduleRecurringTask` in
`src/todoist.ts` and `scripts/bulk-reschedule-tasks.mjs` — does **not** have this
problem; it's specifically interval changes that break. The safe way to actually
change a task's recurrence interval is to **delete the task and recreate it
fresh** with the new `due_string` — plain task creation (no existing recurrence
to mutate) has been reliable all session for this. If you're doing this kind of
edit, rehearse it on a throwaway task first (same discipline as everywhere else
in this file) rather than trusting this description alone — this was only
found by directly hitting it once, not from Todoist's own documentation.

**A recurring task can end up in a state where `POST /tasks/{id}/close` fails
with `400 {"error_code":480,"error_tag":"INVALID_DATE","error":"Unable to
parse \"due_string\" value"}`, even though `due.string` looks completely
normal and the task displays fine** — confirmed directly on one real chore
(a "Lay Out Uniform" task, `due.string` `"every tue, thu at 9:00pm"`). Todoist's
server-side recurrence parser couldn't re-derive the next occurrence from
that task specifically when auto-advancing it on completion. This silently
breaks the dashboard's `complete` tap for that one chore (surfaces on the
tablet as a stuck/no-op tap; `handleCompleteTask` in `src/index.ts` just
calls `closeTask`, which has no title/recurrence-shape awareness to catch
this).

**This is not a general comma-separated/multi-weekday limitation** — don't
assume every `"every X, Y at ..."` task has this problem. Directly tested
every other multi-weekday task in `KIDS_PROJECT_ID` at the time (three
`"every mon, wed at 9:00pm"` "Lay out school clothes" tasks, three `"every
mon, tue, wed, {thu,}fri, sun at 9pm"` "Take Shower" tasks) with a real
complete → reopen round-trip each, and all closed and restored cleanly. The
one broken task was likely left in a bad internal state by whatever earlier
edit also produced the sibling duplicate-task bug on the same three "Lay Out
Uniform" chores — not a
property of the recurrence string's shape. If a chore's `complete` tap stops
working on the tablet, the fix is the same delete-and-recreate-fresh
approach as the interval gotcha above (rehearse the round-trip on it once
via `wrangler dev` + a real `complete`/`reopen` call before trusting a fix),
not a rule to avoid multi-weekday recurrence strings in general.

**Completing an _overdue_ recurring task used to "flash and come back".**
Todoist advances a recurring task from its current due date, not from today, so
closing `every mon, wed` while still due Monday (completed on Wednesday) lands on
Wednesday — today — and the chore reappears on the next poll. `handleCompleteTask`
now calls `catchUpOverdueRecurringTask` (`src/index.ts`): if the task was overdue
by calendar date before the close, it re-fetches and closes again until the next
due date is after today (capped at `MAX_CATCH_UP_CLOSES`, best-effort, never
throws). A task due today is closed once. Reopen still restores the original date
via the client-supplied `dueDate`, so undo covers the multi-close case.

**A Todoist 4xx on `close`/`reopen` is a per-task rejection, not an outage.**
`handleCompleteTask`/`handleReopenTask` catch it (`isTaskRejection`: 4xx except
408/429) and call `reportTaskRejection`: structured `console.error`, one Telegram
alert per task per hour (`reject:alerted:<taskId>`, TTL'd KV key — growth-bounded
like `digest:done:*`) naming the chore, kid and `error_tag`, and a `422` response
(`errorTag` in the body) that makes the tablet show `#action-toast` instead of a
silent revert. It deliberately does **not** count toward the outage alert; 5xx,
timeouts and network errors still propagate as 502 and do. On `INVALID_DATE` the
alert says to delete and recreate the task (see the gotcha above).

**"Nobody can check anything off" is usually the tablet being offline, not a bug.**
If the tablet loses Wi-Fi for days, the page keeps showing its last-loaded
chores and every tap fails. Before debugging the Worker, check the tablet
(`?cmd=deviceInfo`, see below) and Todoist's activity log for the last completion.
A tap whose `fetch` rejects (never reached the server) now shows a "tablet is
offline" toast; a tap the server answered with an error keeps the generic one.
If `.dev.vars`' `DASH_SECRET` is out of sync with production, the tablet's
real key is in its `startUrl` from `deviceInfo`.

## Bulk-editing real chore data

For a one-off change touching more than a couple of real tasks (e.g. rescheduling
a batch of recurring chores), use `scripts/bulk-reschedule-tasks.mjs` rather than
hand-typing individual API calls — it enforces the two things that matter for this
kind of change: refusing to touch any task outside `KIDS_PROJECT_ID`, and rehearsing
the exact reschedule mechanism against a disposable throwaway task first, refusing
to touch real data at all if that rehearsal doesn't land exactly where expected
(Todoist's `due_string: "<pattern> starting <date>"` reconstruction has been
observed to behave differently across recurrence patterns — see the script's own
header comment). Dry-run by default; `--apply` is required to actually change
anything, and every apply writes a timestamped backup (`scripts/backups/`,
gitignored) before making any change. It only ever changes a task's _date_,
never its recurrence _interval_, so it isn't affected by the interval-change
gotcha above — but if you ever extend it to change intervals too, that same
rehearse-on-a-throwaway-first check would need to cover that case specifically.

**Editing chores by hand or through Claude:** the day-to-day procedure (add,
remove, reschedule, retag, change recurrence) is written up as a Claude skill at
`skills/manage-chores/SKILL.md`. It targets the Todoist **MCP** server, not the
raw REST API this Worker uses, so the two can legitimately behave differently.
The interval-change gotcha above is the known case: the REST API breaks the task,
while the skill records an `update-tasks` pattern that has worked through the MCP
(always re-verified with `fetch-object`). When you change Todoist behavior
knowledge in either doc, update the other, and never let them contradict each
other without saying which API each claim is about. The skill's frontmatter is
what Claude desktop and other clients pick up; the copy pasted into a client's
skills settings has to be refreshed by hand after an edit here.

## Local dev / verification

```
npm install
cp .dev.vars.example .dev.vars   # needs a REAL Todoist token to do anything useful
npm run dev                       # wrangler dev on :8787
npm run typecheck                 # tsc --noEmit
npm test                          # vitest run — mocks fetch, no real Todoist calls
npm run test:e2e                  # playwright test — public/ against a static server, mocked API
npm run lint                      # eslint . — src/, test/, public/app.js; not public/index.html (HTML)
npm run format                    # prettier --write . — everything, including public/*.{html,css,js}
```

`test/*.test.ts` covers the pure overdue logic, the Todoist client (pagination,
error handling), and the Worker's routing (auth gate, kid grouping, the
project-ownership check on `complete`/`reopen`) — all against a mocked `fetch`, so
`npm test` needs no real credentials and runs in CI. It intentionally does **not**
hit the real Todoist API; for that, run `wrangler dev`, curl `/api/chores?key=...`
and eyeball the grouping/`isOverdue` values against what's actually in the
**📋 Chore Chart** project, and confirm a `complete`/`reopen` round-trip actually
flips the task in Todoist (not just the JSON response).

CI (`.github/workflows/ci.yml`) runs format-check + lint + typecheck + unit
tests + e2e tests on every push/PR to `main`, and only deploys (`wrangler deploy` via
`cloudflare/wrangler-action`) after those pass on a push to `main` — see the
README's CI/CD section for the required `CLOUDFLARE_API_TOKEN`/
`CLOUDFLARE_ACCOUNT_ID` GitHub secrets. If you add a new Worker behavior, add a
corresponding test in `test/index.test.ts` rather than leaving it only manually
verified — that's what keeps `deploy` trustworthy as a gate.

**Deploying: let CI do it, don't run `wrangler deploy` by hand.** After pushing to
`main`, watch the triggered run (`gh run watch`, or poll `gh run list --limit 1` /
`gh run view <run-id>`). `test` always runs; `deploy` only runs on top of it if the
push touched something deploy-relevant (`src/**`, `public/**`, `wrangler.toml`,
`package.json`, `package-lock.json` — see the `dorny/paths-filter` step) — a
docs-only push (this file, `README.md`)
legitimately shows `test` passing with no `deploy` job at all, that's not a
failure. Confirm the run's actual outcome and say so — don't just assume a push
means it deployed, and don't fall back to a manual `wrangler deploy` to route
around a `test` failure; diagnose it from the job logs (`gh run view --log-failed`)
instead. Running `wrangler deploy` manually right after every push was the old
habit here — it's redundant with CI's own `deploy` job firing moments later on the
same push when one does run (same content deployed twice, harmless but
pointless), which is exactly why this stopped.

**After a `deploy` job succeeds, also reload the physical kiosk tablet — if the
credentials for that are available.** `.dev.vars` can optionally hold
`FULLY_KIOSK_URL` (the tablet's Fully Kiosk Browser Remote Admin REST API base
URL, e.g. `http://192.168.1.50:2323/`) and `FULLY_KIOSK_PW` (its admin
password). These are **not** Cloudflare Worker secrets — the Worker itself
never reads them, they don't go through `wrangler secret put`, and nothing in
`src/` should ever reference them; they exist purely so Claude Code can reload
the physical tablet's browser after a verified deploy, since `public/app.js`
never reloads the page itself (it just polls `/api/chores` as JSON forever), so
a deploy that changes `public/**` never actually reaches the tablet until
something forces a fresh page load. Check `.dev.vars` for both before relying
on this:

- **If both are present**: hit
  `${FULLY_KIOSK_URL}?cmd=loadStartUrl&password=${FULLY_KIOSK_PW}&type=json`
  after a successful `deploy`, then confirm it actually picked up the new
  build — a screenshot via `?cmd=getScreenshot&password=...` is a good way to
  check this visually rather than just trusting the reload command succeeded.
  Also worth a quick `?cmd=deviceInfo&password=...` check alongside the
  screenshot — this is a wall-mounted, always-plugged-in tablet, so its
  battery/charging fields are a cheap, useful health signal (a tablet that's
  silently not charging is a real failure mode for this kind of device), even
  though nothing currently alerts on it automatically.
- **If either is missing**: say so plainly rather than silently skipping the
  step, and offer to add them to `.dev.vars` if the user provides the tablet's
  IP/port and Remote Admin password (Fully Kiosk app: Settings → Remote
  Administration). Don't guess at the tablet's address.

Fully Kiosk's own docs for these two surfaces (useful if the tablet ever needs
more than a `loadStartUrl` reload — e.g. driving it from in-page JS instead of
the REST API): REST interface at
<https://www.fully-kiosk.com/en/#rest>, page-JavaScript integration at
<https://www.fully-kiosk.com/en/#websiteintegration>.

**Turning on `USE_FULLY_KIOSK`/a `FULLY_*` var also needs a Fully Kiosk
device setting flipped — try to do that automatically too.** `window.fully`
(the JS interface `public/app.js`'s optional integration depends on — see the
Conventions entries below) only exists once "Enable JavaScript Interface
(PLUS)" is on for this URL, in Fully Kiosk → Settings → Advanced Web
Settings; `FULLY_NIGHT_SCHEDULE_ENABLED`'s motion-wake additionally needs
Fully's camera-based Motion Detection setting on. When one of these
`wrangler.toml` vars is being turned on, don't just ask the user to flip the
matching Fully Kiosk setting by hand — try it via the REST API first, same
`.dev.vars`-check-first pattern as the tablet reload above:

- **If `FULLY_KIOSK_URL`/`FULLY_KIOSK_PW` are present**: the real setting
  keys are **confirmed** (via `?cmd=listSettings` against the real tablet):
  `websiteIntegration` is "Enable JavaScript Interface (PLUS)" — flipping it
  with `?cmd=setBooleanSetting&key=websiteIntegration&value=true` applies
  immediately (its own response says "Saved and applied...", confirmed by
  re-reading `listSettings` right after — **no `restartApp` needed**, unlike
  `appDarkMode` below); `motionDetection` is Motion Detection. Still verify
  it actually took (re-read via `listSettings`, or a screenshot) before
  relying on it.
- **If either credential is missing**: say so plainly, and tell the user
  which two settings to flip by hand (Settings → Advanced Web Settings →
  Enable JavaScript Interface (PLUS), and → Motion Detection) rather than
  silently leaving `window.fully` unavailable with no explanation.

**But confirming `window.fully` exists is not the same as confirming its
methods match what this project assumes.** During the first on-tablet
rehearsal, a diagnostic `window.fully.showNotification(...)` call (added to
verify the JS interface was really callable) threw — that specific method
either doesn't exist or has a different signature than assumed — and because
it was unwrapped, it broke chore/streak rendering on the live dashboard (see
the `callFully()` Conventions entry below, added because of this — including
a note there on how long this was actually confirmed to last, which is less
than it first sounds). **Don't add a new direct `window.fully.*` call for a
future rehearsal diagnostic without wrapping it in `callFully()` first** —
the whole point of that wrapper is that this exact mistake shouldn't be able
to repeat.

## Task tracking (GitHub Issues)

This repo uses GitHub Issues (`gh issue create`/`gh issue list`/`gh issue
close`) to track work, not just commit history. Open one for anything that's
a real, trackable unit of work — a feature, a bug, a non-trivial follow-up —
especially anything deferred/not-done-yet that could otherwise get lost
between sessions (e.g. two on-tablet checks this
project already knew it owed but hadn't done). Don't open one for a tiny
wording tweak or single-line ask — match the granularity to "would this be
worth its own paragraph in a session summary," not every individual request.

Close an issue via `Closes #N`/`Fixes #N` in the commit message once the work
lands — this repo pushes straight to `main` (no PRs for normal work, see
"Deploying" above), and GitHub honors those keywords on direct pushes to the
default branch the same as on a merged PR, so no extra step is needed beyond
using the right words in the commit message.

## Conventions

- No external frontend dependencies, no bundler — `public/index.html`,
  `public/style.css`, and `public/app.js` are plain files Workers Static Assets
  serves as-is, which is what makes the "one Worker, one deploy, same-origin"
  architecture work without a build step. They used to be one inline file;
  split apart for editability (real syntax highlighting/tooling, and ESLint can
  now actually lint `app.js`) without giving up anything that mattered — same
  origin, same deploy, still zero build step either way. `index.html` just
  references the other two with a normal `<link rel="stylesheet">`/`<script
src>`, both same-origin.
- Keep the Worker itself dependency-free beyond `@cloudflare/workers-types` (dev-only,
  for types) — there's no reason for a runtime dependency here.
- `public/_headers` (Cloudflare's declarative headers-file convention, same as
  Pages) sets CSP/`X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy`
  on every static asset response. It does **not** apply to `/api/*` — those are
  Worker-generated responses, and `_headers` rules only apply to responses the
  static-asset layer serves without the Worker touching them; if `/api/*` ever
  needs security headers of its own, they'd need to be set directly on the
  `Response` in `src/index.ts`. If you touch the CSP, verify via `wrangler dev`
  that kid-color styling (`element.style.setProperty` in `app.js`) and the
  Open-Meteo weather fetch still work — both are exactly the kind of thing an
  overly strict `style-src`/`connect-src` would silently break.
- `wrangler.toml` `KIDS_PROJECT_ID` must match whatever Todoist project actually
  holds the kid chores — if that project is ever recreated, update this value.
- `wrangler.toml` `KIDS` ("Name:#hexcolor,..." — see `parseKids()` in
  `src/index.ts`) is the entire kid roster. It's a plain var, not a secret — a
  kid's first name isn't sensitive — but it drives Todoist label matching, the
  `/api/chores` response shape, digest lines, and every frontend column, so
  changing it changes what the whole app considers "a kid."
- `FAILURE_STATE` (KV) is genuinely optional infrastructure, not just an optional
  secret — every function that touches it (`withTodoistFailureTracking`/
  `recordHeartbeat`/`checkHeartbeat`, `recordDigestCompletion`/
  `undoDigestCompletion`, `recordDailyCleanStatus`/`getKidStreak`, all in
  `src/index.ts`) checks `env.FAILURE_STATE` before touching it, same pattern as
  the Telegram vars. Don't make it required; local dev and tests should keep
  working with it unbound. The name is now a misnomer — it started out purely for
  Todoist-failure/dead-tablet alerting, but also backs the nightly digest's
  completion counts and the streak feature; not worth a rename/migration for a
  single-binding personal project, but don't be surprised finding streak data in
  something called `FAILURE_STATE`. The two features on it use different
  KV-growth-bounding strategies, worth matching to whichever fits a new feature:
  digest completions are date-keyed with a TTL (`digest:done:<date>:<kidKey>`,
  `DIGEST_COMPLETION_TTL_SECONDS`) so old entries just expire; streaks are one
  fixed key per kid (`streak:<kidKey>`) whose array gets trimmed to
  `STREAK_HISTORY_DAYS` in code on every write, so the key count never grows at
  all regardless of how long the dashboard runs. Both exist specifically to avoid
  repeating the unbounded-key-growth shape of bug that caused the KV-quota outage
  this project already had once (see `recordTodoistSuccess`/`recordHeartbeat`'s
  own comments) — a new KV-backed feature should pick one of these two shapes
  deliberately, not grow an unbounded key-per-day/event pattern by default.
- `AVATARS` (R2, optional) holds per-kid avatar photos, one photo per kid,
  object key `${kid.key}.jpg` or `${kid.key}.png` — `handleGetAvatar` in
  `src/index.ts` tries `.jpg` first, then `.png`, and derives the
  content-type fallback from whichever extension actually matched (so a PNG
  uploaded with no explicit content-type isn't mislabeled `image/jpeg`).
  Same optional-infra pattern as `FAILURE_STATE` — `handleGetAvatar` checks
  `env.AVATARS` before touching it, degrades to a 404 if unbound or the kid
  has no photo, and `public/app.js`'s `buildAvatar()` already treats any
  failed/missing load as "show the colored-initial fallback," so a plain 404
  is the entire contract. Served through an **authenticated** route
  (`GET /api/avatars/:kidKey`, same `?key=` gate as everything else) rather
  than a plain `public/` static file — this is deliberate, not an oversight:
  static files bypass the Worker/auth entirely (see the "no kid name
  hardcoded" hard constraint above), so a photo there would be the first
  kid-identifying thing in this app reachable with no secret at all. Because
  the route itself requires the secret, the object key can safely just be
  the kid's own name — no obscure/random filename needed the way a static
  file would have required. **`wrangler r2 object put/get/delete` need
  `--remote`** — confirmed by directly hitting this once: without it, they
  silently target a local-simulated bucket (the same one `wrangler dev`
  reads from), separate from the real bucket the deployed dashboard uses, so
  an upload "succeeds" but the tablet never sees it. See the README's avatar
  section for the actual commands.
- `wrangler.toml`'s `USE_FULLY_KIOSK`/`FULLY_*` vars and `WEATHER_LAT`/
  `WEATHER_LON` are plain vars, not secrets, parsed server-side
  (`parseFullyKioskConfig`/`parseWeatherLocation` in `src/index.ts`) and
  threaded through the `/api/chores` response as `fullyKiosk`/`weather` —
  exactly the same "one config source, no build step" pattern as
  `eveningStartsAtMinutes`. Despite living in `src/index.ts`, none of this is
  server-side computation — it's 100% frontend behavior (`public/app.js`'s
  optional Fully Kiosk integration, and the Open-Meteo weather fetch); it's
  threaded through the API purely so `app.js` never hardcodes deploy-time
  config, the same reasoning `EVENING_STARTS_AT` already established. If you
  add another piece of frontend-only config, prefer this pattern over a new
  hardcoded `app.js` constant — see the git history around this change if you
  want the fuller reasoning (a build step and a KV-backed runtime config were
  both considered and rejected here).
- **Every `window.fully.*` call in `public/app.js` must go through `callFully()`,
  never called directly.** This isn't defensive-for-its-own-sake — an unwrapped
  call (a one-off diagnostic added during on-tablet rehearsal, calling a method
  that either doesn't exist or has a different signature than assumed) threw on
  the real tablet and broke chore/streak rendering on the live dashboard,
  because it ran inside `poll()`'s response handler and an uncaught exception
  there aborts everything after it in that same callback — taking
  `render()`/`renderStreaks()` down with it, not just the Fully-specific
  behavior. (The observed downtime was only confirmed within a single ~45s
  poll cycle right after a fresh page load — reverted before ever letting a
  second poll cycle run, so whether it would have self-healed on its own
  isn't actually known; not worth re-testing on the real tablet just to find
  out, since `callFully()` is a strict improvement regardless.) `callFully()`
  contains any such mismatch to a `console.error`, since this project has no
  way to verify Fully's real JS API surface without a real tablet (see the
  `websiteIntegration`/`motionDetection` REST setting names above — confirmed
  the same way, empirically). `e2e/fully-kiosk.spec.ts` has a regression test
  for exactly this (a throwing fake `window.fully` method, asserting
  chores/streaks still render and no page error escapes, confirmed to
  actually fail without `callFully()` before this was trusted) — if you add a
  new `window.fully.*` call site, wrap it the same way. A similarly-named
  test in `e2e/dashboard.spec.ts` (malformed `/api/chores` data) looks like
  the same kind of regression test but isn't one — see that test's own
  comment for why its claim turned out to hold regardless of poll()'s
  try/catch, given this codebase's actual state-assignment order.
- `wrangler.toml`'s three cron entries are told apart in `scheduled` by matching
  `event.cron` against `DIGEST_CRON` and `MIDNIGHT_SKIP_CRON` — anything else
  falls through to the heartbeat check (which also runs `deliverSkipNotices` and
  `maybeSendSnowReminder`). If you change either cron's expression in
  `wrangler.toml`, update the matching constant in `src/index.ts` or that job
  silently starts running as the wrong one.
- **The auto chore skip is one shared engine** (`runAutoSkip` + a `SkipSpec`),
  with two flavours — rain-aware (`RAIN_SKIP_*`) and calendar/no-school-aware
  (`SCHOOL_SKIP_*`), all vars optional and off by default. It's server-side
  behavior, so unlike the `FULLY_*`/`WEATHER_*` vars none of it is threaded
  through `/api/chores`. Each flavour's `qualifies()` decides if today counts
  (rain: forecast over both thresholds; school: date in the calendar-file ∪
  manual-flag set) and returns a `detail` string; `isEligible()` picks the
  chores (rain: `titleMatchesRainSkip` against the comma-separated
  case-insensitive `RAIN_SKIP_MATCH`; school: the `SCHOOL_SKIP_LABEL` Todoist
  label). The 00:15 cron closes matching due-today chores silently and writes
  one date-keyed KV record per flavour (`rain:skip:<date>` / `school:skip:<date>`,
  2-day TTL — same growth-bounded shape as `digest:done:*`); it stores the closed
  tasks' actual titles so the notice/digest name them (`describeSkipChores`,
  falling back to a bare count for a record predating `closedTitles`). The
  heartbeat tick's `deliverSkipNotices` sends one Telegram notice per flavour
  past `SKIP_NOTIFY_HOUR`; `skipDigestNotes` adds the digest line(s). Chores
  close whether or not `FAILURE_STATE` is bound — only the notice/digest need it.
  Two idempotency guards: the KV record, and the "due today" filter (a re-fire
  sees the already-advanced task). `RAIN_SKIP_COUNTS_AS_DONE` defaults `true`,
  `SCHOOL_SKIP_COUNTS_AS_DONE` `false` (a holiday isn't an accomplishment; the
  streak is protected either way, since closing removes the chore from "open").
- The no-school date set is `public/school-calendar.json` (regenerated by
  `scripts/refresh-school-calendar.mjs` from the district's iCal feed), read
  server-side via the `ASSETS` binding (`src/schoolcalendar.ts`), unioned with a
  **runtime manual flag** in `FAILURE_STATE` (`school:skip:manual`, a
  `{date: reason}` map pruned to ~14 days). The file also has **`termStart`/
  `termEnd`** (first/last student day) — `schoolcalendar.ts` treats any date
  outside that window as no-school ("Summer break"), which is how the summer gap
  the feed doesn't enumerate gets covered. Those two are hand-maintained; the
  refresh script only preserves them (auto-deriving from the feed's own
  `First day for students` / `Last Day for students` events is an Option
  B (deferred). `GET/POST/DELETE /api/school-skip[/today]`
  (`handleSchoolSkipFlag`, same `?key=` gate) manages the flag; the `POST` also
  runs `runSchoolSkipCheck` inline so flagging a snow day at 6am clears today's
  chores immediately, not at next midnight. A date list + holiday names isn't
  kid-identifying, so serving `school-calendar.json` unauthenticated from
  `public/` is a deliberate, checked exception to the "nothing kid-identifying
  without a secret" hard constraint (same kind of call as weather coords in
  `/api/chores` being fine but avatars not).
- `maybeSendSnowReminder` (`SNOW_REMINDER_*`, optional, off) never skips anything
  — a snow day is the district's call. On a would-be school day (weekday, not
  already a known no-school day) whose forecast turns wintry (`snowfall_sum` ≥
  `SNOW_REMINDER_MIN_CM` or a wintry `weather_code`), it sends one Telegram nudge
  past `SNOW_REMINDER_HOUR` to flag the day manually. Deduped by a
  `snow:reminded:<date>` KV key.
- `e2e/*.spec.ts` (Playwright, `npm run test:e2e`) covers the frontend's own
  JS/CSS — chore grouping/overdue display, Day/Evening tab filtering, the
  complete/reopen tap flow, the invalid-key error state, and
  (`e2e/fully-kiosk.spec.ts`) the Fully Kiosk integration's brightness/
  day-keepawake/night-schedule/motion-wake behavior, the master-switch-off
  no-op path, per-feature independence, and (a real-incident regression test)
  that a throwing `window.fully.*` call is contained by `callFully()` rather
  than breaking chore/streak rendering — served by `e2e/static-server.mjs`
  (a plain static file server, deliberately not `wrangler dev`) with every
  network call mocked via Playwright route interception, so it needs no
  Worker, no Todoist data, and no credentials, same as `npm test`. The Fully
  Kiosk cases work by injecting a fake `window.fully` via `page.addInitScript`
  (recording calls instead of doing anything real) and using Playwright's
  `page.clock` to pin the page to a known day/night instant deterministically
  — see that file for the pattern if you add another clock-dependent feature;
  it's a genuinely better fit here than the "manual `wrangler dev` only"
  fallback below, since nothing about it is real-timing-flaky. The kiosk's
  debounce (`pendingIds`) and completion celebration (`justCompletedIds`)
  aren't covered by e2e — those are harder to assert on without flaky timing
  — so still verify changes to those specifically via `wrangler dev` in an
  actual browser. Also not (and can't be) covered by e2e: whether Fully Kiosk
  itself really invokes `window.motionDetected` the way `updateFullyScreenSchedule`
  assumes — that's only confirmable on the real tablet with Motion Detection
  and the JS Interface both on; see the deploy-workflow section above. If you
  add new frontend behavior, add an `e2e/` case for it the same way you'd add
  a `test/*.test.ts` case for backend behavior.
- Formatting is Prettier (`.prettierrc.json`), linting is ESLint flat config
  (`eslint.config.mjs`, `typescript-eslint` recommended + `eslint-config-prettier`
  so the two never fight). ESLint covers `src/`, `test/`, `e2e/`, `scripts/`, and
  `public/app.js` (with `globals.browser`, not the Worker/Node globals the rest
  of the repo gets — it runs in the kiosk's browser); `public/index.html` is
  still excluded (it's HTML, not JS) and stays Prettier-formatted only. Run
  `npm run format` before committing; CI's `format:check` and `lint` fail the
  build the same way a broken test would, so don't skip them locally and let CI
  find out.
- Dependency updates are `.github/dependabot.yml` (npm + github-actions, weekly).
  This replaced an earlier self-hosted-Renovate setup — Renovate authors PRs
  through the repo's own Actions `GITHUB_TOKEN`, which GitHub hard-blocks from
  ever touching `.github/workflows/**`, so it could only ever cover npm. Dependabot
  is a native GitHub feature (no workflow file, no `GITHUB_TOKEN` involved in how
  it authors PRs at all), so it isn't subject to that restriction and covers both
  ecosystems cleanly. Don't reintroduce a self-hosted Renovate workflow without a
  real reason — it's strictly more setup/maintenance surface for less coverage
  than what's here now.
