---
name: manage-chores
description: >-
  Add, remove, reschedule, retag, or change the recurrence of the kids' chores
  that feed the chore-dashboard wall tablet (github.com/your-username/chore-dashboard).
  Chores are Todoist tasks in the "📋 Chore Chart" project. Use whenever the user
  wants to change what chores the kids see, who does them, when they are due, or
  how often they repeat.
---

# Managing chores

The chore-dashboard is a wall-mounted tablet that shows each kid's chores for
**today + overdue**, sourced live from Todoist. There is no database — **Todoist
is the only source of truth**. Editing chore data is just editing Todoist tasks;
no deploy, no code change. The tablet re-polls every ~45s.

## Requirements & portability

The only thing this skill needs is **Todoist connected** — the Todoist MCP server
in Claude Code (desktop/CLI), or the Todoist connector in the Claude app
(web/iOS/Android). It is the same underlying Todoist MCP everywhere, so the tool
names and the workarounds below hold on every platform. Every fixed value
(project ID, labels) is inline here, so **no repo checkout is required**.

Todoist tool names used below: `find-tasks`, `fetch-object`, `add-tasks`,
`update-tasks`, `reschedule-tasks`, `complete-tasks`, `delete-object`. If your
client names them slightly differently, map by intent.

If `github.com/your-username/chore-dashboard` happens to be checked out, `README.md`
and `CLAUDE.md` have extra background and `scripts/bulk-reschedule-tasks.mjs` is a
guarded bulk editor — but nothing here depends on them.

## Quick reference

| Thing                                                                 | Value                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Chore project **"📋 Chore Chart"** (`KIDS_PROJECT_ID`)                | `YOUR_TODOIST_PROJECT_ID`                                                |
| **Never touch** — "✅ Chores" (adult/household, not on the dashboard) | `YOUR_OTHER_PROJECT_ID`                                                  |
| Kid labels (exact, case-sensitive)                                    | `Alex`, `Sam`, `Taylor`                                                  |
| School-day-only label (auto-skips on no-school days)                  | `school-day`                                                             |
| Timezone                                                              | `America/New_York` (times are floating / no explicit zone)               |
| Day vs Evening tab boundary                                           | `16:00` (a chore with **no time** shows in both)                         |
| Default priority                                                      | `p4` (leave it there unless asked)                                       |
| Title convention                                                      | emoji + Title Case, e.g. `🗑️ Take out garbage`, `📖 Read for 20 minutes` |

Adding/removing/renaming a **kid** is a `wrangler.toml` (`KIDS`) edit + redeploy
in the repo — out of scope here; this skill only touches chores for the kids
already configured.

## Hard rules

1. **Stay inside the Chore Chart project.** Every task you create, update,
   reschedule, or delete must have `projectId === "YOUR_TODOIST_PROJECT_ID"`. When the
   user names a chore, `find-tasks` it first and confirm the `projectId` on each
   match. A same-named task can exist in the separate "✅ Chores" project — never
   touch that one.
2. **Kid identity is the label, not the assignee.** A chore shows in a kid's
   column only if it carries that kid's exact label. No kid label → it lands in
   an "unlabeled" bucket, on nobody's column. Always tag ≥1 kid. Don't use
   Todoist's assignee feature for this.
3. **Only chores due today or overdue are visible.** A future-dated chore is
   hidden until its due date. Say so when a change won't show up right away.
4. **Show before you mutate.** List what `find-tasks` returned (title, kid label,
   `recurring`, `dueDate`) and confirm with the user before any delete, retag, or
   recurrence change. Chores are usually one task **per kid**, so "remove X"
   often means 3 deletes — name each.
5. **Verify after every write** — see the golden rule below.

## Todoist MCP quirks — the safe call patterns

These were verified empirically against the live Todoist MCP. Follow them exactly;
the "obvious" tool for a job is often the wrong one.

### Golden rule: the write response echoes your _request_, not the result

`add-tasks` / `update-tasks` / `reschedule-tasks` return the payload you sent,
even when the change didn't take. `reschedule-tasks` was seen returning
`dueDate: "2026-09-22T18:00:00"` while the task never actually moved.

**After every write, call `fetch-object` (type `task`) on the task and check
`dueDate` and `recurring` are what you intended.** Report those actual values
back to the user.

### Moving or retiming a recurring chore → `update-tasks` with a full `dueString`, NOT `reschedule-tasks`

`reschedule-tasks` is unreliable on **recurring** tasks:

- date-only (`"2026-09-20"`) → moves the date but **drops the time of day**. The
  chore becomes date-only, so on the dashboard it shows in **both** Day and
  Evening tabs and loses its timed-overdue behavior.
- datetime (`"2026-09-20T20:25:00"`) → **sometimes silently reverts** to the
  original date (observed when the passed time differs from the recurrence rule's
  time). Not dependable.

The pattern that worked **every time**: `update-tasks` with

```
dueString: "<full recurrence phrase incl. time> starting <YYYY-MM-DD>"
```

e.g. `"every 3 days at 8:25pm starting 2026-09-20"`. It sets the exact next
occurrence (date **and** time, from the phrase) and preserves recurrence. You
must pass the **complete** phrase — interval + any weekdays + time — copied from
the task's current `recurring` string, not a fragment.

`reschedule-tasks` **is** fine for **non-recurring** one-off chores.

### Changing interval / weekday pattern → one `update-tasks` call

`update-tasks` with `dueString: "every 5 days at 8:25pm starting <date>"` on a
task that was "every 3 days" correctly changes the interval, recalculates the
next occurrence, and keeps it recurring. (The repo's `CLAUDE.md` warns that
interval changes wipe the task — that was the _raw REST API_; the MCP is a
different, working path. Still verify with `fetch-object`.)

- **This conflicts with the repo's `CLAUDE.md` on purpose, and both are
  scoped:** `CLAUDE.md` documents the raw REST API (`api.todoist.com/api/v1`),
  where an interval change via `due_string` wiped the due date or was silently
  ignored, so it says delete and recreate. This skill documents the Todoist
  MCP, where the `update-tasks` pattern below has worked. Do not assume one
  result carries over to the other path. If a `fetch-object` after the write
  shows `dueDate: null`, a lost `recurring`, or the old interval, fall back to
  delete + recreate.
- **Always include `starting <date>`.** Without it, `update-tasks` re-anchors and
  **skips the current occurrence forward by one interval** — a chore due today
  would jump to next cycle and disappear from the dashboard.
- Delete + recreate still works if you prefer it, but it's not required.

### Other quirks

- **`labels` on `update-tasks` fully replaces the array.** To switch kid but keep
  school-day, pass `["Sam","school-day"]`, not `["Sam"]`.
- **`find-tasks` defaults to `limit: 10`; this project has ~46 tasks.** Always
  pass `limit: 100` (paginate with `cursor` if ever more), and set
  `responsibleUserFiltering: "all"` so a task assigned to Alex's own Todoist
  account isn't hidden.
- **Send only changed fields to `update-tasks`.** Never include `projectId` /
  `sectionId` / `parentId` unless you intend a move — the MCP treats them as one.
- **A typo'd label is silently created as a new empty label** and the chore won't
  appear on the dashboard. Use the exact strings `Alex` / `Sam` / `Taylor` /
  `school-day`.
- **New recurring chore:** append `starting <YYYY-MM-DD>` to `dueString` to place
  the first occurrence; otherwise Todoist picks the next cadence date from today.
- **`delete-object` `type:task`** removes a recurring chore and all future
  occurrences. `complete-tasks` only advances it to the next date — that's the
  tablet's Done button, never use it to "remove" a chore.

## Recipes

Every recipe ends with: `fetch-object` the affected task(s), confirm
`dueDate` + `recurring` + `labels`, report them.

### Add a chore

`add-tasks` with:

- `projectId`: `YOUR_TODOIST_PROJECT_ID`
- `content`: emoji + Title Case title
- `labels`: `["Alex"]` (one per kid); add `"school-day"` if it only needs doing
  on school days (lunch box, school reading, …)
- `dueString`: natural-language recurrence in the house style —
  `every day at 8:30pm`, `every other day at 8:45pm`, `every weekday at 7:30pm`,
  `every mon, wed at 9:00pm`, `every 3 days at 8:25pm`,
  `every 3 weeks sunday at 12:00pm`. Add `starting <YYYY-MM-DD>` to control the
  first occurrence. A time-of-day is normal here; it decides the Day/Evening tab.
- leave `priority` at `p4`.

**Same chore for several kids:**

- **One shared task**, `labels: ["Alex","Sam","Taylor"]` — shows in all columns; a
  kid marking it done completes it for everyone (it's one task). Good for shared
  jobs ("Clean playroom").
- **One task per kid** (same title, one kid label each) — the project default,
  and required for rotations or per-kid times. Pass all entries in one
  `add-tasks` call.

New chores stay hidden on the tablet until their first due date is today.

### Remove a chore

1. `find-tasks` `projectId: "YOUR_TODOIST_PROJECT_ID"`, `limit: 100`,
   `responsibleUserFiltering: "all"`, `searchText` the title.
2. Confirm each match's `projectId`; list matches (usually one per kid); confirm
   scope with the user.
3. `delete-object` `type: "task"` per id.

### Reschedule / move a chore, keeping its recurrence

`update-tasks` with `dueString: "<current recurring phrase> starting <YYYY-MM-DD>"`.

- First `fetch-object` the task to copy its exact `recurring` string.
- Use this to push to tomorrow, **pause** (set `starting` to a future date — it
  vanishes from the tablet until then), stagger rotation start dates, or shift
  the day.
- Do **not** use `reschedule-tasks` here (see quirks).

### Change the time of day (same interval)

Same as above: `update-tasks` `dueString` = the recurring phrase with the new
time and `starting <the occurrence's own date>`, e.g.
`"every day at 8:00pm starting 2026-09-12"`. Confirms via `fetch-object` that
`dueDate` landed on that date at the new time.

### Change how often a chore repeats

`update-tasks` with `dueString: "<new interval/pattern> at <time> starting <date>"`,
once per per-kid copy. Verify each with `fetch-object`. (Or delete + recreate.)

### Reassign a chore to a different kid (manual rotation handoff)

`update-tasks` with `labels` = the **full** new array (it replaces). Keep
`school-day` if it was there: `["Taylor","school-day"]`. Send nothing else.

### Toggle school-day-only

`update-tasks` `labels` = kid label ± `"school-day"` (full array).

### One-off (non-recurring) chore

`add-tasks` with `dueString` like `today` / `saturday` / `tomorrow at 4pm` and a
kid label. `reschedule-tasks` is fine for moving these later. Completing it closes
it for good.

## Rotations

Todoist can't express "alternating kid" on one task. Use multiple tasks whose due
windows never overlap, so the today+overdue filter surfaces exactly one at a time
and it flips automatically. Set each task's first occurrence with the
`update-tasks` + `starting <date>` pattern above.

- **Two kids, weekly** (trash alternates Alex/Taylor): two tasks, same title, one
  kid label each, both `every 2 weeks <weekday> at <time>`; first due dates one
  week apart.
- **3+ kids, or more than one day a week** (bathroom every Thu _and_ Sun,
  rotating Alex/Sam/Taylor): one task per (weekday, kid) — 6 tasks — each
  `every 3 weeks on <weekday>` (N = number of kids), first dates staggered a week
  per kid, the two weekday tracks offset by one kid so nobody owns both days the
  same week:

  ```
          Sunday   Thursday
  Week 1: Sam      Alex
  Week 2: Taylor   Sam
  Week 3: Alex     Taylor   (repeats)
  ```

- **Irregular / skip-a-turn:** one task you manually retag to the next kid when
  it's their turn (see "Reassign a chore").

## After changes

- No deploy or tablet reload needed — the tablet re-polls automatically.
- Always finish by reporting each touched task's actual `dueDate`, `recurring`,
  and `labels` from a fresh `fetch-object`.
- Only **kid roster**, **label name**, or **project id** changes need a
  `wrangler.toml` edit + redeploy in the repo.
