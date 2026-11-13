# 📋 Chore Dashboard

A live chore chart for a wall-mounted tablet (Android tablet running [Fully
Kiosk Browser](https://www.fully-kiosk.com/)), showing chores for a configurable
set of kids (currently Alex, Sam, and Taylor), sourced from Todoist. Kids tap a
chore card to mark it done; a Cloudflare Worker is the only thing that talks to
Todoist, and it serves the frontend too, so the whole thing is a single
`wrangler deploy`.

This app is built and verified against **Fully Kiosk Browser on Android
specifically** — it hasn't been run under any other kiosk app or on iOS. It isn't
a hard requirement, though: on any other browser the frontend just degrades to
plain due-today/overdue chore cards, without the Fully-specific behavior described
below. Those extra features (see [Fully Kiosk Browser](#-fully-kiosk-browser)) call
into Fully Kiosk's own device/JS APIs; they're opt-in, off by default, and always
confirmed with whoever runs the deployment before being turned on.

## ⚙️ Architecture

Everything lives behind one Worker (`src/index.ts`), deployed with Workers Static
Assets so a single `wrangler deploy` publishes both the frontend and the API,
same-origin, no CORS:

- Static files in `public/` (`index.html`, `style.css`, `app.js`, and
  `school-calendar.json`) are served automatically for any request that matches a
  file. Requests that don't match anything — i.e. everything under `/api/*` —
  fall through to the Worker's `fetch` handler.
- The Worker is the **only** thing holding the real Todoist API token, set as the
  `TODOIST_TOKEN` secret (`wrangler secret put`, never committed, never in
  `wrangler.toml`).
- Every request must include `?key=<DASH_SECRET>` matching the `DASH_SECRET` secret,
  checked first in the `fetch` handler (403 on mismatch). This is deliberately
  lightweight — an "obscure but not nothing" gate appropriate for a kiosk URL, not a
  real auth system. For stronger protection, put the Worker behind [Cloudflare
  Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
  (available on Cloudflare Pro).
- The target Todoist project is hardcoded via the `KIDS_PROJECT_ID` var in
  `wrangler.toml`. Every write endpoint (`complete`/`reopen`) re-fetches the task
  first and checks `task.project_id === KIDS_PROJECT_ID` before touching it — this
  is the hard backstop that keeps the Worker's blast radius limited to this one
  project, even though the underlying Todoist token technically has access to the
  whole account. A leaked dashboard URL can only read/complete chores in **📋 Chore
  Chart**, nothing else.

Routes:

| Method        | Path                       | Does                                                                                                                                                         |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET           | `/api/chores`              | Returns the configured kid list (`kids`) and today's + overdue chores grouped by kid key plus `unlabeled` (`groups`), each with `isOverdue`.                 |
| POST          | `/api/chores/:id/complete` | Closes the task in Todoist (validated to be in the kid-chores project first).                                                                                |
| POST          | `/api/chores/:id/reopen`   | Reopens the task (same validation) — used when a kid mis-taps.                                                                                               |
| GET           | `/api/avatars/:kidKey`     | Returns that kid's avatar photo from R2, or 404 if none is uploaded (frontend falls back to the colored-initial avatar).                                     |
| GET           | `/api/school-skip`         | Lists the runtime manual no-school dates (`{date: reason}`) — see [Automatic chore skipping](#-automatic-chore-skipping).                                    |
| POST / DELETE | `/api/school-skip/today`   | Adds / removes a manual no-school date (defaults to today; `?date=`/`?reason=` override). `POST` also clears today's school-day chores if the feature is on. |

`src/todoist.ts` is the thin Todoist API client (handles the `/api/v1` base URL and
the list endpoint's cursor-based pagination).

## 🧒 Configuring who it's for

The entire kid roster — names, Todoist label, and each column's accent color — is
one line: `KIDS` in `wrangler.toml`'s `[vars]`, e.g.

```
KIDS = "Alex:#4d9bff,Sam:#4dd68a,Taylor:#ffb14d"
```

Comma-separated `Name:#hexcolor` pairs, any number of kids (not just 3). `Name` is
both the exact Todoist label a chore must be tagged with (case-sensitive) and what's
displayed on the dashboard; the lowercased name is used as the internal grouping key
(JSON response keys, digest lines). Nothing else in the app hardcodes a name —
`parseKids()` in `src/index.ts` is the single source of truth, and the frontend
(`public/index.html`) builds its columns dynamically from whatever the API reports,
rather than having any kid baked into the markup. Add, remove, rename, or recolor a
kid by editing this one line and redeploying — no code changes.

**Avatar photos** are optional per kid — no `KIDS` change needed, since the
dashboard always attempts to load one for every kid (falling back to a colored
circle with their first initial if there isn't one, or the load fails). Photos
are stored in an R2 bucket, not a plain file under `public/` — static files
there are served by Cloudflare's asset layer _before_ the Worker's own code
ever runs, meaning anyone could fetch them with no `?key=<DASH_SECRET>` at
all, which is exactly why this app never hardcodes a kid's name in `src/`/
`public/` in the first place. A photo behind an authenticated route
(`GET /api/avatars/:kidKey`, gated by the same `?key=` check as everything
else) doesn't have that problem, so the R2 object can just use the kid's own
`key` as its filename.

To add a kid's photo, one-time bucket setup (already done for this
deployment, see `wrangler.toml`'s `[[r2_buckets]]`):

```
npx wrangler r2 bucket create chore-dashboard-avatars
```

then per kid:

```
npx wrangler r2 object put chore-dashboard-avatars/<kidKey>.jpg \
  --file=<path-to-photo.jpg> --content-type=image/jpeg --remote
```

**`--remote` is required** — `wrangler r2 object put`/`get`/`delete` default to a
_local_, simulated bucket (the same one `wrangler dev` reads from), separate from
the real bucket the deployed dashboard actually uses. Omitting `--remote` will
appear to succeed but the photo won't show up on the real dashboard/tablet at all.

JPEG or PNG both work — use a `.png` object key with `--content-type=image/png`
for a PNG photo instead. The route tries `.jpg` first, then `.png`, per kid, so
only upload one or the other (if both exist for a kid, the `.jpg` wins).

`<kidKey>` is the kid's lowercased name (e.g. `alex`). No redeploy needed —
the dashboard picks it up on the next poll. To remove a photo (revert to the
initial-circle fallback), delete the object (again with `--remote`):
`npx wrangler r2 object delete chore-dashboard-avatars/<kidKey>.jpg --remote`
(or `.png`, matching whichever extension you uploaded).

## ✅ How chores work

All chores live in a single Todoist project: **📋 Chore Chart**, kept separate from any other
project you have, such as a general **✅ Chores** project for adult/household tasks — the dashboard never touches that one.

**Adding a chore:** create a task in **📋 Chore Chart** as you normally would in
Todoist, and tag it with one or more of the labels `Alex`, `Sam`, `Taylor` (this
deployment's configured kids — see [Configuring who it's for](#-configuring-who-its-for)
above) — that label is the only thing that determines which column(s) a chore shows
up in on the dashboard. A task can carry more than one kid's label (e.g. a shared
chore like "Clean playroom" tagged `Alex`, `Sam`, `Taylor` shows up in all three
columns; tapping it done in any one column completes it everywhere, since it's the
same task).

We deliberately don't use Todoist's task "assignee" feature for this — only Alex has their own Todoist account, and Sam/Taylor don't need one.

**Recurrence** is entirely Todoist-native: set it the normal way (e.g. "every day",
"every mon, thu"). Completing a recurring task in Todoist automatically schedules the
next occurrence; the dashboard doesn't do anything special for recurrence, it just
reads whatever due date Todoist currently reports.

**Due dates / times** are optional. A chore due "today" with no time just needs to
happen sometime today. A chore due at a specific time (e.g. "today at 4pm") is
overdue once that time passes — see [Due date / overdue logic](#-due-date--overdue-logic)
below.

That's the whole common case. The rest of this section is rotation recipes —
skip it unless you need one.

### Rotating a chore between kids

**Alternating one chore between two kids** (e.g. "take out trash" alternates
Alex/Taylor week to week) isn't something Todoist's recurrence syntax can express
directly on a single task — there's no "every other week, alternating assignee"
option, and we don't use Todoist's assignee feature anyway (see above). The
dashboard-native way to do it with zero manual upkeep:

1. Create **two separate tasks** with the same title (e.g. "Take out trash"), one
   tagged `Alex` and one tagged `Taylor`.
2. Give both the same recurrence interval, but stagger their start dates by half the
   interval. For a weekly rotation, that's "every 2 weeks" on each, with Alex's
   first due date one week before Taylor's (e.g. Alex starts this Monday, Taylor starts
   next Monday).
3. Because the dashboard only shows chores due today or overdue (see
   [Due date / overdue logic](#-due-date--overdue-logic)), only one of the two
   tasks is ever in range at a time — so only one kid sees "Take out trash" on a
   given week, and it flips automatically every cycle. No relabeling, no manual
   edits.

If you'd rather control the handoff by hand instead (e.g. an irregular rotation, or
you want to skip a turn sometimes), the simpler alternative is a single task that
you manually re-tag with the other kid's label in the Todoist app whenever it's
someone else's turn.

**Rotating among 3+ kids, or on more than one day a week** (e.g. "wipe down the
bathroom" happens every Thursday _and_ Sunday, rotating through Alex/Sam/Taylor)
needs one more trick: the gap between the two weekdays isn't constant (Thu→Sun is 3
days, Sun→Thu is 4), so no single "every N days" interval lands on both. Instead,
split it into one independent weekly track per weekday, each rotating through all 3
kids on its own 3-week cycle (`every 3 weeks on <weekday>`), and offset the two
tracks by one kid so nobody is ever on the hook for both days in the same week:

```
        Sunday   Thursday
Week 1: Sam      Alex
Week 2: Taylor   Sam
Week 3: Alex     Taylor
(repeats)
```

That's **6 tasks** (3 kids × 2 weekday-tracks), each `every 3 weeks on sunday` or
`every 3 weeks on thursday`, with staggered starting dates so they interleave as
above. Generalizes to any number of weekdays/kids: one task per (weekday, kid) pair,
recurring every _(kids)_ weeks on that weekday, with starting dates staggered by one
week per kid and the tracks offset from each other so the same kid never lands on
two different weekdays in the same week.

**What happens if a kid doesn't finish their turn?** Because each kid's task
recurs independently (it only advances when _that_ task is completed), a
missed "Take out trash" just stays overdue in Alex's column indefinitely —
it doesn't hold up Taylor's task, which comes due on its own schedule
regardless. Both kids can end up seeing the identical chore title at once,
with nothing on-screen explaining why. The dashboard doesn't merge or auto-close
either task over this (Todoist stays untouched, and Alex's streak still takes
the hit that night — see the next section), but Taylor's card gets a small note
("🔁 Alex hasn't finished this yet") so the overlap reads as a rotation
handoff instead of looking like duplicated/broken data.

**Editing chores with Claude:** [`skills/manage-chores/SKILL.md`](skills/manage-chores/SKILL.md)
is a Claude skill that walks through adding, removing, rescheduling, retagging,
and changing the recurrence of chores via the Todoist MCP, including the call
patterns that avoid its known quirks.

## ⏰ Due date / overdue logic

The dashboard only shows chores that are **due today or already overdue** (future-dated
chores are hidden — the kiosk shows "what's actionable now"). This filtering and the
`isOverdue` flag are computed server-side, in `src/overdue.ts`, against the current
time in `America/New_York` (the app's timezone, hardcoded as `TIMEZONE` in
`src/index.ts`).

Two cases, based on Todoist's `due` object:

- **Date-only due date** (e.g. `"2026-08-22"`, no time set): the chore is overdue
  once the calendar date in `America/New_York` has moved past it. A chore due
  "today" is never overdue until tomorrow.
- **Due date with a specific time** (e.g. `"2026-08-22T16:00:00"`): the chore is
  overdue once that exact moment has passed. If Todoist attaches a specific IANA
  timezone to the due date (`due.timezone`), that zone is used; if it's a "floating"
  time (`due.timezone` is `null`), it's treated as `America/New_York` — which is
  also the account's own timezone, so this is normally what you want anyway.

Todoist's REST API v2 was retired (it now returns `410 Gone`); this project uses
their newer unified `/api/v1/` API. One relevant difference: the old API returned a
separate pre-computed `due.datetime` (already in UTC) alongside `due.date`. The new
API only returns `due.date` (which is either a plain date or a naive local
datetime string) plus `due.timezone` — so `overdue.ts` does its own timezone-aware
conversion to a real UTC instant (`zonedWallTimeToInstant`) rather than relying on
a ready-made field.

### Day / Evening tabs

The dashboard also splits chores into two tappable tabs — Day and Evening — based
on each chore's due **time**, independent of the due-today-or-overdue filtering
and overdue badge above (a chore due at 9am shows in the Day tab all day
regardless of the current time, and still gets the OVERDUE badge once 9am passes,
exactly as it would without the tabs). The boundary between the two is one config
value, `EVENING_STARTS_AT` in `wrangler.toml`'s `[vars]` (`"HH:MM"`, 24h, in
`TIMEZONE`) — Day is `[00:00, EVENING_STARTS_AT)`, Evening is
`[EVENING_STARTS_AT, 24:00)`, the whole day covered with no gap. `overdue.ts`'s
`dueTimeMinutes()` resolves a chore's due time to minutes-since-midnight (reusing
the same zone-conversion logic as `isOverdue`, so it's correct for floating times,
explicit-zone times, and DST the same way); `handleGetChores` sends both that
per-chore value and `eveningStartsAtMinutes` (the parsed config) to the frontend,
which builds the tab labels and does the actual filtering — see the
[Frontend](#-frontend) section below. A chore with **no time set** (still the
default — Todoist due dates are date-only unless you explicitly add a time) shows
in **both** tabs, so nothing disappears just because it hasn't been given a time
yet. An **overdue** chore also shows in both tabs regardless of which slot its due
time falls in — once something's overdue, which slot it was originally scheduled
for stops being the relevant fact about it, and a kid checking one tab shouldn't
have to also check the other just to see an unfinished chore from earlier.

## 📨 Telegram notifications

Optional — everything Telegram-related is off unless `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` are both set as Worker secrets. All of it is also best-effort: a
Telegram failure is logged and swallowed, never turned into an error response or a
thrown exception, since nothing user-facing should break just because a
notification didn't go out.

**One-time Telegram setup:**

1. In Telegram, message [@BotFather](https://t.me/BotFather) → `/newbot` → follow the
   prompts. You'll get a bot token (looks like `123456789:AAExampleTokenHere`).
2. Add the bot to your group chat.
3. Get the chat's numeric ID — the simplest way is to send any message in the group,
   then visit `https://api.telegram.org/bot<your bot token>/getUpdates` in a browser
   and find `"chat":{"id":...}` in the response (group chat IDs are negative
   numbers, e.g. `-1001234567890`).
4. Set both as Worker secrets (see [Deployment](#-deployment) below).

**Chore completions:** after a `complete`/`reopen` call succeeds in Todoist, the
Worker posts a message, e.g. "✅ Alex finished: Make bed" or "↩️ Taylor undid: Make
bed". If a chore has more than one kid label, all of them are named ("✅ Alex, Sam
& Taylor finished: Clean playroom"). Implemented by `notifyTelegram` in `src/index.ts`.

Beyond completions, the same chat also gets the [nightly digest](#-nightly-digest--streaks),
the [automatic-skip notices](#-automatic-chore-skipping), and the
[health alerts](#-health--reliability) — all gated on the same two secrets.

## 📊 Nightly digest & streaks

**Nightly digest:** once a day, a Cloudflare [Cron
Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
(`[triggers].crons` in `wrangler.toml`, wired to the Worker's `scheduled` handler)
runs `runDailyDigest`, which posts a per-kid summary:

```
📊 Chore summary — Fri Aug 22
Alex: ✅ 3 done · 🕗 1 still open
Sam: ✅ 2 done · 🎉 all done!
Taylor: ✅ 1 done · 🕗 2 still open
```

"Still open" reuses the same due-today-or-overdue grouping the live `/api/chores`
endpoint uses. "Done" does **not** come from Todoist's completed-tasks endpoint —
that only reflects tasks Todoist itself considers permanently closed, and
completing a _recurring_ task (nearly every chore here) reschedules it instead,
so it never shows up there at all; that endpoint stays empty for this project
regardless of real activity. Instead, `handleCompleteTask`/`handleReopenTask` in
`src/index.ts` track completions themselves in `FAILURE_STATE`, right alongside
the existing Telegram notification for each — a per-kid, per-day list of task ids
(`digest:done:<date>:<kidKey>`, a few days' TTL) that a same-day reopen (undoing a
mis-tap) removes from again, so a tap-then-immediately-undo correctly doesn't
count. The cron expression is a fixed UTC hour (currently 8pm `America/New_York`
in EDT), so it drifts by an hour across the two DST transitions each year —
cosmetic, documented in `wrangler.toml`, not worth chasing with a
timezone-aware schedule.

**Streaks & history:** each kid's column shows a `🔥 N days` badge and a 6-day
history strip (plus a live "today" dot) under their name. A day counts as
"clean" if nothing was left open by digest time — a day with **zero** chores
due counts as clean too, the same as a day where everything got done. This
piggybacks on the same `open` count `runDailyDigest` already computes for the
"still open" line above, via `recordDailyCleanStatus`: one JSON array per kid
(`streak:<kidKey>` in `FAILURE_STATE`, no per-day keys, no TTL — the array is
just trimmed to the last 7 entries on every write, so it's 3 fixed KV keys
total regardless of how long the dashboard has been running). `GET
/api/chores` reads it back via `getKidStreak` into a top-level `streaks` field
(`{streak, history}` per kid key) — `history` never includes today, so the
frontend can always render "today" as its own live, unresolved dot rather than
reconciling it against a KV record that may or may not exist yet depending on
whether tonight's digest has run.

## 🌧️ Automatic chore skipping

Some chores don't need doing on some days — the yard doesn't need watering when it's
pouring, and the lunch box doesn't need emptying on a school holiday. Rather than
let those chores sit on the board going overdue and breaking streaks, a Cron
Trigger (`15 5 * * *` = 00:15 `America/New_York` in EST / 01:15 in EDT, always
just after local midnight) closes the ones that qualify (all optional, off by
default). Closing a recurring task just advances it to its next occurrence, so the
streak/overdue logic needs no special case. Two flavours share one engine
(`runAutoSkip` + a `SkipSpec` per flavour):

- **Rain-aware** (`RAIN_SKIP_ENABLED`) — `runRainSkipCheck` asks
  [Open-Meteo](https://open-meteo.com/) for the day's forecast (`src/weather.ts`,
  same lat/lon as the header weather) and, **only if `precipitation_hours` is over
  `RAIN_SKIP_MIN_HOURS` _and_ `precipitation_sum` is at least `RAIN_SKIP_MIN_MM`**
  (both — a brief downpour shouldn't read as "rained all day"), closes every chore
  due that day whose title matches `RAIN_SKIP_MATCH` — a **comma-separated list of
  case-insensitive title substrings** (default `"Water the Yard"`); a chore
  matching **any** entry is eligible, so several distinct watering chores are
  handled in one run. `RAIN_SKIP_COUNTS_AS_DONE` (default `true`).
- **Calendar-aware** (`SCHOOL_SKIP_ENABLED`) — `runSchoolSkipCheck` closes every
  chore due that day carrying the `SCHOOL_SKIP_LABEL` Todoist label (default
  `"school-day"`) when the date is a district no-school day. The no-school dates
  live in **`public/school-calendar.json`**, regenerated from the district's public
  iCal feed by `node scripts/refresh-school-calendar.mjs` (run it to seed, then
  once a year) — the Worker reads the committed file via its `ASSETS` binding, it
  never parses ICS itself. Set `SCHOOL_SKIP_CALENDAR_URL` to fetch a different
  source instead. The file also carries **`termStart`/`termEnd`** (the first and
  last student day, hand-maintained — the feed doesn't enumerate summer): any
  date outside that window counts as no-school too, so summer break and the
  late-August / mid-June shoulder gaps are covered without listing every weekday.
  The refresh script preserves those two dates across a re-run.
  `SCHOOL_SKIP_COUNTS_AS_DONE` defaults `false` — a holiday isn't an
  accomplishment, though the streak is protected either way.

  A **runtime manual flag** covers closures the calendar can't know about (snow
  days): `POST /api/school-skip/today?key=…` (optionally `&date=`/`&reason=`) adds
  a date to `school:skip:manual` in `FAILURE_STATE` (a `{date: reason}` map,
  pruned to the last two weeks) and, if `SCHOOL_SKIP_ENABLED` is on, immediately
  runs the school-skip so the chores clear right away rather than at next
  midnight. `GET /api/school-skip` lists it; `DELETE …/today` undoes it.

The midnight run is **silent** — no phone should buzz at 00:15. It writes a small
`FAILURE_STATE` record (`rain:skip:<date>` / `school:skip:<date>`, 2-day TTL), and
the **heartbeat tick** delivers the Telegram heads-up (`deliverSkipNotices`) on
its first run at or after `SKIP_NOTIFY_HOUR` (default 9am local — riding the
every-15-minutes tick rather than its own cron gets an exact 9am-local send
without a fixed-UTC cron's DST drift). It sends once per flavour, marks the record
`notified`, retries on the next tick if a send fails, and adds a
"🌧️ Rainy day — …" / "🏫 Veterans Day — …" line to that night's digest — all
naming the actual chore titles closed. With `FAILURE_STATE` unbound the chores
still get closed; only the notice and digest line are skipped.

**Snow-day reminder** (optional — `SNOW_REMINDER_ENABLED`): it never skips
anything on its own, because a snow day is the district's call, not the forecast's.
On a would-be school day (a weekday that isn't already a known no-school day) whose
forecast turns wintry — `snowfall_sum` at/above `SNOW_REMINDER_MIN_CM`, or a
wintry `weather_code` — the heartbeat tick sends **one** Telegram nudge (past
`SNOW_REMINDER_HOUR`, default 6am, when closures are usually announced) to flag the
day manually if school does close.

## 🩺 Health & reliability

**Consecutive-failure alerts:** the kiosk's own "Reconnecting…" banner is the only
signal of a Todoist outage unless something else surfaces it. `withTodoistFailureTracking`
in `src/index.ts` wraps every Todoist-touching route, tracking _when_ a run of
Todoist failures started in the `FAILURE_STATE` KV namespace; once it's been failing
continuously for ~2 minutes it sends one Telegram alert ("⚠️ Todoist has been failing
for N minutes…") and stays quiet on further failures until a success clears the
state — so an outage alerts once, not every ~45s poll. This is time-based rather
than a simple failure count specifically to stay correct under concurrent requests
(e.g. a phone and the tablet both polling during the same outage) — Workers KV has
no compare-and-swap, so a naive counter can lose increments when two requests read
it at the same time; recording a timestamp once and comparing elapsed time doesn't
have that race.
`FAILURE_STATE` is a KV binding (see `wrangler.toml`), not a secret — if it's ever
recreated, `npx wrangler kv namespace create FAILURE_STATE` and update the `id` in
`wrangler.toml`. This feature degrades gracefully to a no-op if the binding is
missing (e.g. in tests, or local `wrangler dev` without a `[[kv_namespaces]]`
entry pointed at a real namespace).

**Dead-tablet alerts:** the failure tracking above only fires when a request
_arrives and fails_ — it can't notice the tablet going silent entirely (powered
off, crashed, Wi-Fi down for good). `recordHeartbeat` in `src/index.ts` stamps
`FAILURE_STATE` with the current time on every authenticated request, and a second,
more frequent Cron Trigger (`*/15 * * * *`, alongside the nightly digest's
`0 0 * * *` in `wrangler.toml`) runs `checkHeartbeat`, which sends one Telegram
alert ("📵 No request from the dashboard in N minutes…") once that timestamp is
more than 30 minutes stale, staying quiet on repeats the same way the Todoist
failure alert does, and resetting once traffic resumes.

**Cron dispatch:** the `scheduled` handler tells the three cron jobs apart by
matching `event.cron` against the digest's and the auto-skip's exact strings
(`DIGEST_CRON` / `MIDNIGHT_SKIP_CRON` in `src/index.ts`) — anything else is
treated as the heartbeat check (which also delivers the deferred skip notices and
the snow-day reminder).

## 🖥️ Frontend

The frontend is `public/index.html`, `public/style.css`, and `public/app.js` —
plain files, no build step, and no external requests besides same-origin
`/api/*` and a direct client-side call to Open-Meteo for weather (see below). It:

- Header shows current weather (stacked: temp large on top, today's high/low
  smaller underneath), date (e.g. "August 22nd" — `ordinal()` in `app.js`,
  since `Intl.DateTimeFormat` has no built-in ordinal-suffix option), and time,
  refreshed every 15s (time) / 30 minutes (weather).
- Shows one column per configured kid (`buildColumns()`, built dynamically from the
  `/api/chores` response's `kids` list — nothing frontend-side is hardcoded to a
  specific name or count), large tap targets.
- A **Day / Evening tab row** (`buildSlotRow()`) filters which cards are visible by
  each chore's `dueTimeMinutes` against the server-reported `eveningStartsAtMinutes`
  — see [Day / Evening tabs](#day--evening-tabs) above for the actual boundary
  logic. The tab matching the real current time auto-selects (checked every 15s
  alongside the clock, same tick that already drives the sun-based theme), but
  tapping the other tab sticks until the schedule itself moves on to the next real
  transition, not the very next clock tick — `updateActiveSlot()` tracks the real
  current slot separately from what's actually being displayed for exactly this
  reason.
- Flags overdue chores with a red border + "OVERDUE" badge.
- Tapping a card optimistically toggles it done/undone immediately, then calls
  `complete`/`reopen`, reconciling with the next poll. Tapping a completed card
  again reopens it (the built-in "undo a mis-tap" path).
- Completing a chore triggers a brief card-pop animation (pure CSS, no assets) —
  reopening doesn't, to keep undos low-key. (A confetti-particle version of this
  was tried and pulled — it didn't render reliably across browsers/WebViews.)
  Repeat taps on the same card while its request is in flight are ignored
  (`pendingIds` in `app.js`), so a kid mashing a card doesn't fire a pile
  of duplicate complete/reopen calls.
- Polls `/api/chores` every ~45s (with a little jitter) so chores added/completed
  from someone's phone show up on the tablet without a manual refresh.
- On a poll failure (e.g. brief Wi-Fi hiccup), keeps showing the last-known data with
  a small "Reconnecting…" indicator and keeps retrying — never a blank/broken screen.
- Reads `?key=...` once from its own URL and reuses it on every API call.

**Weather** is fetched client-side directly from
[Open-Meteo](https://open-meteo.com/) — free, no API key/signup, CORS-enabled, so
no need to route it through the Worker or store a secret for it. The location is
configurable: `WEATHER_LAT`/`WEATHER_LON` in `wrangler.toml`'s `[vars]` (currently
New York, NY — `40.7128, -74.006`, found via Open-Meteo's [geocoding
API](https://open-meteo.com/en/docs/geocoding-api)), sent to the frontend as part
of the `/api/chores` response the same way `eveningStartsAtMinutes` is. On a fetch
failure, the last-known weather just stays on screen rather than blanking.

**Light/dark theme follows the actual sun**, not the tablet's OS setting or
`prefers-color-scheme`. The same weather request also asks Open-Meteo for today's
`sunrise`/`sunset` (as `timeformat=unixtime` — unambiguous unix seconds, so there's
no risk of a bare local-time string like `"06:42"` getting parsed in the wrong zone
by the tablet's own JS engine). `applyTheme()` compares the current instant against
those two timestamps and sets `data-theme="light"`/`"dark"` on `<html>`, which
flips a full token palette (`:root` vs. `:root[data-theme="light"]` in the
`<style>` block) — everything from page background to card borders is a CSS
variable, nothing hardcoded per-theme. It's rechecked every 15s (piggybacking on
the clock tick, no extra network call) so the switch happens close to the actual
moment of sunrise/sunset rather than waiting up to 30 minutes for the next weather
poll. Before the first weather fetch resolves, the page stays on the dark default.

The page declares `color-scheme` (both a `<meta name="color-scheme">` tag and the
CSS property, set per-theme on `:root`/`:root[data-theme="light"]`) so browsers
know it manages its own palette and shouldn't apply their own algorithmic
darkening on top of it. This turned out to matter in practice: on the wall tablet,
the dashboard was stuck in dark mode in broad daylight even though `data-theme` and
every computed color were correctly `"light"` — the DOM was right, but Fully Kiosk
Browser's own **`appDarkMode` setting** (separate from its "Night Mode"
screen-dimming feature) was forcibly dark-rendering the WebView's output regardless
of the page's content, which `color-scheme` alone couldn't override. See
[Fully Kiosk Browser](#-fully-kiosk-browser) below.

## 📱 Fully Kiosk Browser

This dashboard is built and verified against [Fully Kiosk
Browser](https://www.fully-kiosk.com/) specifically — see the note at the top of
this README. The [device setup](#device-setup) below applies regardless of what's
rendering the page; the deeper [integration](#integration-optional-off-by-default)
with Fully Kiosk's own device/JS APIs is opt-in and off by default.

### Integration (optional, off by default)

Beyond the plain-browser behavior above, the dashboard can optionally call into
[Fully Kiosk Browser](https://www.fully-kiosk.com/)'s own `window.fully` JS
interface for a few tablet-specific behaviors. Each is its own independent toggle;
nothing Fully-specific turns on without asking first.

Everything is a plain `wrangler.toml` var (`[vars]`, same tier as `KIDS`/
`EVENING_STARTS_AT` — not secrets, just deploy-time config), gated by both a
master switch and a per-feature enable flag:

| Var                                                      | Default           | Controls                                                                                                                                 |
| -------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `USE_FULLY_KIOSK`                                        | `false`           | Master switch — nothing below does anything unless this is `true` **and** the browser actually exposes `window.fully`.                   |
| `FULLY_BRIGHTNESS_ENABLED`                               | `false`           | Dims the screen at night using the same sun-based day/night signal that already drives the light/dark theme.                             |
| `FULLY_DAY_BRIGHTNESS` / `FULLY_NIGHT_BRIGHTNESS`        | `100` / `30`      | Brightness percent (0-100) used by the above.                                                                                            |
| `FULLY_DAY_KEEPAWAKE_ENABLED`                            | `false`           | Forces the screen to never time out while it's the app's "day" (defense in depth on top of Fully's own "Keep Screen On" device setting). |
| `FULLY_NIGHT_SCHEDULE_ENABLED`                           | `false`           | Turns the screen off overnight on a fixed schedule, waking on motion for a grace period, then re-sleeping.                               |
| `FULLY_NIGHT_SCREEN_OFF_AT` / `FULLY_NIGHT_SCREEN_ON_AT` | `23:00` / `05:00` | The overnight window (`HH:MM`, 24h, `America/New_York`), used by the above.                                                              |
| `FULLY_MOTION_WAKE_GRACE_MINUTES`                        | `2`               | How long the screen stays on after the last detected motion before going back to sleep.                                                  |

Each of the three features is independent — e.g. brightness dimming can be on
while the night schedule stays off. The three flags/config values are parsed
server-side (`parseFullyKioskConfig` in `src/index.ts`) and sent down as part
of the `/api/chores` response (`fullyKiosk`), the same "one config source"
pattern `eveningStartsAtMinutes` already uses — `public/app.js` never
hardcodes any of this.

**`FULLY_NIGHT_SCHEDULE_ENABLED`'s motion-wake needs Fully Kiosk's own
camera-based Motion Detection feature turned on** (separate from the
JavaScript Interface setting below) — worth being explicit about: this means
Fully Kiosk's front camera is actively watching for motion during the night
window, on a device three kids stand in front of daily. That's a real
privacy tradeoff, not just an API call, and is exactly the kind of thing this
README's opening caveat means by "always confirmed first" before being
turned on.

**Prerequisite in Fully Kiosk itself:** `window.fully` only exists once
"Enable JavaScript Interface (PLUS)" is turned on for this URL, in Fully
Kiosk → Settings → Advanced Web Settings (and Motion Detection, separately,
for the night-schedule feature). Rather than always doing this by hand,
turning on `USE_FULLY_KIOSK` (or a specific per-feature var) also has Claude
Code try to flip the matching Fully Kiosk device setting(s) automatically via
the Remote Admin REST API — see `CLAUDE.md`'s deploy-workflow section for
how, and what happens when the `.dev.vars` credentials it needs for that
aren't available.

### Device setup

On the wall-mounted tablet, in Fully Kiosk Browser:

- **Start URL**: `https://chores.example.com/?key=<your DASH_SECRET>`
- Disable pull-to-refresh (the page polls itself; a manual refresh isn't needed and
  would just flash the last-known state).
- Enable "keep screen on" / disable sleep, since this is meant to be an always-on
  wall display.
- Optionally enable Fully Kiosk's own auto-reload-on-error as a second safety net on
  top of the page's built-in retry/reconnect handling.
- **Leave Fully Kiosk's own `appDarkMode` setting off.** When on, it force-renders
  the WebView's content dark regardless of what the page itself sets — it overrode
  this dashboard's sun-based light theme in broad daylight even though the page's
  own `data-theme`/CSS were correctly `"light"` throughout. It's a separate setting
  from Fully Kiosk's "Night Mode" (screen-dimming) feature. If the dashboard is ever
  stuck in dark mode during the day, check this first. Also note: toggling it only
  takes effect after a full app restart (Remote Admin → `restartApp`, or manually
  relaunching the app) — reloading the page alone isn't enough, since this is a
  WebView-level setting applied when the WebView is created, not something a page
  navigation re-applies.
- **Set Fully Kiosk's own idle screensaver timeout (`timeToScreensaverV2`,
  Settings → Other Settings → Screensaver) to `0` (disabled).** This is a
  separate device setting from `appDarkMode` above and from this project's own
  `FULLY_NIGHT_SCHEDULE_ENABLED` — it defaults to `90` seconds, and since
  nobody touches a wall-mounted display most of the day, the tablet spends
  nearly all its time in Fully's own screensaver state (`isInScreensaver: true`
  in `deviceInfo`), which suspends/throttles the WebView's JS timers even
  though the screen itself stays on. Confirmed directly: two Remote Admin
  `getScreenshot` captures ~25s apart came back byte-identical (a frozen
  clock — `app.js`'s `setInterval(updateClock, 15000)` had genuinely stopped,
  not just a stale render), and disabling this setting fixed it. If the
  dashboard is ever stuck (frozen clock, stale weather, a theme that never
  flips), check this alongside `appDarkMode` — they cause different symptoms
  from different mechanisms and both need checking.

## 🛠️ Development

### Local development

```
npm install
cp .dev.vars.example .dev.vars   # fill in a real TODOIST_TOKEN and any DASH_SECRET
npm run dev                       # wrangler dev, http://localhost:8787
```

Open `http://localhost:8787/?key=<your DASH_SECRET>`.

`npm run typecheck` runs `tsc --noEmit`.

### Formatting and linting

```
npm run format         # prettier --write . — reformats in place
npm run format:check   # prettier --check . — used in CI, doesn't modify files
npm run lint            # eslint . (flat config: eslint.config.mjs)
```

Prettier (`.prettierrc.json`) covers `src/`, `test/`, `e2e/`, `scripts/`,
everything under `public/` (`index.html`, `style.css`, `app.js`), and the
Markdown docs. ESLint (`typescript-eslint`'s recommended rules, plus
`eslint-config-prettier` to turn off any formatting-related rule that would
fight Prettier) covers `src/`, `test/`, `e2e/`, `scripts/`, and `public/app.js`
— `public/index.html` is HTML, not JS, so it's Prettier-formatted only; verify
markup/behavior changes there via `wrangler dev` in a real browser or the e2e
suite below. Both run in CI alongside typecheck/test and block the deploy the
same way a failing test would.

### Testing

```
npm test          # vitest run — one-shot, used in CI
npm run test:watch
```

The suite (`test/*.test.ts`) never talks to real Todoist — `fetch` is mocked with
`vi.stubGlobal` in every test that needs it. It covers:

- `overdue.ts` — pure date/timezone logic (date-only vs. timed due dates, floating
  vs. explicit-zone times), directly, with no mocking needed.
- `todoist.ts` — pagination through `{results, next_cursor}`, and that a non-2xx
  response throws `TodoistApiError`.
- `index.ts` — the Worker's routing end-to-end: the auth gate, kid-label grouping
  and overdue-flagging, the project-ownership check on `complete`/`reopen`, error
  propagation (a failed Todoist call surfaces as `502`, not a silent 200),
  `runDailyDigest`'s done/open counts, the consecutive-failure alert and the
  dead-tablet heartbeat alert (both fire once at their threshold, stay quiet on
  repeats, and reset appropriately) using an in-memory fake for the
  `FAILURE_STATE` KV binding, the rain- and calendar-aware skip checks and their
  deferred ~9am notices (`runRainSkipCheck` / `runSchoolSkipCheck` /
  `deliverSkipNotices` — thresholds, the no-school label + calendar/manual date
  set, the due-today filter, the KV idempotency guard, the silent-then-notify
  split, `COUNTS_AS_DONE`), the `/api/school-skip` manual flag routes, the
  weather-triggered snow-day reminder (`maybeSendSnowReminder`), and `scheduled`'s
  dispatch across the digest, midnight-skip, and heartbeat cron jobs.
- `weather.ts` — the Open-Meteo daily-forecast client (URL shape, mm/cm parsing,
  non-2xx and empty-body throws).
- `schoolcalendar.ts` — the committed-file loader for the no-school date set
  (asset vs. URL source, well-formed-date filtering, fail-open on any error).
- `telegram.ts` — the notification client, and (via `index.ts`'s tests) that it's
  skipped when unconfigured and that its failures never affect the API response.

The frontend has its own suite, `e2e/*.spec.ts` (Playwright, `npm run test:e2e`):
chore grouping/overdue display, Day/Evening tab filtering, the complete/reopen
tap flow, the invalid-key error state, and (`e2e/fully-kiosk.spec.ts`) the
Fully Kiosk integration's brightness/keep-awake/night-schedule/motion-wake
behavior, the master-switch-off no-op path, and per-feature independence —
using a fake `window.fully` (`page.addInitScript`) and Playwright's
`page.clock` to pin the page to a known day/night instant deterministically,
rather than depending on real wall-clock time. All of it is served by a plain
static file server (`e2e/static-server.mjs`, not `wrangler dev`) with every
network call mocked, so — like `npm test` — it needs no Worker, no Todoist
data, and no credentials. Two things still aren't covered by it (harder to
assert on without flaky timing, or inherently impossible from a static-server
e2e suite) and need manual/real-tablet verification instead: the tap debounce
(`pendingIds`) and completion celebration (`justCompletedIds`) via `wrangler
dev` in a real browser, and — for the Fully Kiosk integration specifically —
whether Fully Kiosk itself really invokes `window.motionDetected` the way the
design assumes, which only the real tablet (with Motion Detection and the JS
Interface both on) can confirm.

## 🚀 Deployment

### ✋ Manual

1. Generate a Todoist personal API token: Todoist → Settings → Integrations →
   Developer.
2. `npx wrangler secret put TODOIST_TOKEN` (paste the token).
3. `npx wrangler secret put DASH_SECRET` (pick any random string).
4. Optional — for Telegram notifications (see above for how to get these):
   `npx wrangler secret put TELEGRAM_BOT_TOKEN` and
   `npx wrangler secret put TELEGRAM_CHAT_ID`.
5. `npx wrangler deploy`.
6. Note the URL it prints — currently `https://chores.example.com` (see Custom
   domain below); a fresh setup without a `routes` entry in `wrangler.toml` would
   print a `*.workers.dev` URL instead.

If the Todoist project is ever recreated, update `KIDS_PROJECT_ID` in
`wrangler.toml` and redeploy.

### 🌐 Custom domain

The Worker is served at **`https://chores.example.com`** via the `routes` entry in
`wrangler.toml` (`chores.example.com` on the `example.com` zone, already on
Cloudflare, `custom_domain = true`). Cloudflare provisions the DNS record and TLS
certificate automatically on deploy — no manual DNS or certificate steps.

Adding any `routes` entry to `wrangler.toml` disables the `*.workers.dev` URL by
default (a wrangler default, not something we opted into) — so
`chore-dashboard.your-subdomain.workers.dev` now 404s. If you ever want both to work
simultaneously (e.g. while migrating), set `workers_dev = true` alongside `routes`
in `wrangler.toml`.

### 🔁 CI/CD (GitHub Actions)

`.github/workflows/ci.yml` runs on every push/PR to `main`:

- **`test` job** (always, every push/PR): `npm ci`, `npm run format:check`,
  `npm run lint`, `npm run typecheck`, `npm test`. Also computes, via
  [`dorny/paths-filter`](https://github.com/dorny/paths-filter), whether the push
  touched anything deploy-relevant (`src/**`, `public/**`, `wrangler.toml`,
  `package.json`, `package-lock.json`). The lockfile/manifest are included even
  though this project has zero runtime dependencies today (see `CLAUDE.md`) — a
  devDependency-only bump costing one harmless extra deploy is a much smaller risk
  than a future _runtime_ dependency bump silently skipping one.
- **`deploy` job**: runs `wrangler deploy` via
  [`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action),
  gated on all three: a push (not a PR) to `main`, `needs: test` passing (so a
  failing test/lint/format/typecheck blocks it), **and** that path-filter output
  being true — a push that only touches docs (this README, `CLAUDE.md`, etc.) still
  runs the full `test` job but skips `deploy`, since there's nothing to deploy.

Deploy **is not run manually** (`npx wrangler deploy`) as part of normal workflow —
push to `main` and let CI's `deploy` job handle it. After pushing, confirm the run
actually succeeded (e.g. `gh run watch`) rather than assuming; see `CLAUDE.md` for
the fuller rationale.

One-time setup, in the GitHub repo's **Settings → Secrets and variables → Actions**,
add two repo secrets:

- `CLOUDFLARE_API_TOKEN` — a Cloudflare API token (not the Todoist token). Create one
  at Cloudflare dashboard → My Profile → API Tokens → Create Token → the "Edit
  Cloudflare Workers" template is sufficient.
- `CLOUDFLARE_ACCOUNT_ID` — found in the Cloudflare dashboard sidebar on any domain
  overview page, or via `npx wrangler whoami`.

`TODOIST_TOKEN` and `DASH_SECRET` stay exactly where they already are — Worker
secrets set via `wrangler secret put`, living in Cloudflare, never touched by CI.
The test suite doesn't need a real Todoist token since it mocks `fetch`.

### 🤖 Dependency updates (Dependabot)

`.github/dependabot.yml` covers two ecosystems, both on a Monday-morning weekly
schedule: `npm` (this project's devDependencies) and `github-actions` (the version
pins in `.github/workflows/*.yml`, e.g. `actions/checkout`, `wrangler-action`).
Minor/patch npm bumps are grouped into one PR via the `groups:` key, to cut down on
noise; GitHub Actions bumps aren't grouped (there are only a couple, not worth it).

This project used **self-hosted Renovate** first, and switched to Dependabot after
running into real friction: Renovate opens PRs by pushing through the repo's own
Actions `GITHUB_TOKEN`, and GitHub hard-blocks that token from ever modifying
`.github/workflows/**`, full stop — no `permissions` grant can override it,
regardless of config. Working around it would've meant provisioning a PAT with the
`workflow` scope or a GitHub App, undercutting the entire point of choosing
self-hosted (avoiding a third-party credential with repo access) in the first
place, so Renovate ended up only covering npm. **Dependabot doesn't have this
problem** — it's a native GitHub feature, not something running as a workflow at
all, so it never touches the repo's own `GITHUB_TOKEN` and isn't subject to that
restriction. It authors PRs using GitHub's own first-party service credentials,
scoped automatically to this one repo, same as any other GitHub-native feature —
no separate token to provision, no workflow file to maintain, no repo settings
toggle to flip (self-hosted Renovate needed all three; see the git history around
the switch if curious what that involved).

The tradeoff going the other way: Dependabot's `groups:` key is considerably
coarser than Renovate's `packageRules` (no regex/monorepo-path grouping, no
merge-confidence badges, no dependency dashboard) — none of which this project's
two ecosystems and one package.json actually need.

Dependabot PRs run through the normal `test` job like any other PR — nothing
auto-merges; review and merge them like any other PR.
