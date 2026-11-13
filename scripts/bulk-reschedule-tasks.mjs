#!/usr/bin/env node
// Bulk-reschedule recurring Todoist tasks, safely — built after a 29-task manual
// bulk reschedule this project needed once (hand-typing target dates into a chat
// turn, backed by a hand-written backup file). This script exists so that never has
// to be done by hand again. It encodes the two things that went right that day and
// makes them mandatory instead of optional:
//
//   1. Never trust a task id without confirming it's inside KIDS_PROJECT_ID first
//      (same rule as getOwnedTask in src/index.ts — this tool has direct API access,
//      unlike the tablet, so it's the one place that check has to be enforced by hand).
//   2. Never apply an unfamiliar reschedule mechanism to real data without proving
//      it does what you think first. Todoist's `due_string: "<pattern> starting
//      <date>"` reconstruction (the same one rescheduleRecurringTask in
//      src/todoist.ts uses) has been observed, empirically, to sometimes land
//      exactly on <date> and sometimes land one full recurrence interval *after*
//      <date> depending on the pattern — undocumented, not fully understood, and not
//      worth re-deriving from first principles every time. So this script doesn't
//      assume either way: for every distinct recurrence pattern in the plan, it
//      rehearses the exact same reschedule against a disposable throwaway task first
//      and refuses to touch anything real unless the result lands exactly on the
//      requested date. No auto-correction — a mismatch means "stop and look", not
//      "guess an offset and proceed."
//
// Usage:
//   node scripts/bulk-reschedule-tasks.mjs <plan.json>            # dry run (default, safe)
//   node scripts/bulk-reschedule-tasks.mjs <plan.json> --apply    # self-tests, then applies
//
// Plan file: a JSON array of { "id": "<task id>", "date": "<YYYY-MM-DD or
// YYYY-MM-DDTHH:MM:SS>", "label": "<optional human note, shown in the dry-run>" }.
//
// Needs TODOIST_TOKEN — read from .dev.vars if present (same file `wrangler dev`
// uses), otherwise from the environment. Needs KIDS_PROJECT_ID — read from
// wrangler.toml. Never touches TODOIST_TOKEN/DASH_SECRET itself, never prints the
// token.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_BASE = "https://api.todoist.com/api/v1";
const BACKUP_DIR = join(ROOT, "scripts", "backups");

/** Throws rather than calling process.exit() directly — this gets called from
 * inside selfTestPattern's try block, which has a finally that deletes the
 * throwaway test task; process.exit() would tear the process down immediately
 * without ever running that finally, leaving the test task orphaned in the
 * real project (this happened once, during this file's own development —
 * see main()'s top-level catch, which is the one place that actually exits,
 * only after every enclosing finally has already run during normal exception
 * unwinding). */
function fail(message) {
  throw new Error(message);
}

async function loadDevVar(name) {
  const path = join(ROOT, ".dev.vars");
  if (!existsSync(path)) return undefined;
  const contents = await readFile(path, "utf8");
  const match = contents.match(new RegExp(`^${name}=(.*)$`, "m"));
  return match ? match[1].trim() : undefined;
}

async function loadWranglerVar(name) {
  const contents = await readFile(join(ROOT, "wrangler.toml"), "utf8");
  const match = contents.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"));
  return match ? match[1] : undefined;
}

async function todoist(token, path, init) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
  });
  if (!res.ok) {
    throw new Error(`Todoist ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

function assertOwned(task, kidsProjectId, context) {
  if (task.project_id !== kidsProjectId) {
    fail(
      `Task ${task.id} (${context}) belongs to project ${task.project_id}, not KIDS_PROJECT_ID (${kidsProjectId}). ` +
        `Refusing to touch it or anything else in this plan — fix the plan file and re-run.`
    );
  }
}

/** Mirrors rescheduleRecurringTask in src/todoist.ts exactly (same due_string
 * reconstruction) — duplicated rather than imported so this script stays a plain,
 * dependency-free Node script with no TypeScript loader needed, consistent with
 * e2e/static-server.mjs. If you change the mechanism in src/todoist.ts, change it
 * here too. */
async function rescheduleViaDueString(token, id, recurrenceString, dueDate) {
  const anchorDate = dueDate.slice(0, 10);
  await todoist(token, `/tasks/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ due_string: `${recurrenceString} starting ${anchorDate}` }),
  });
}

async function selfTestPattern(token, kidsProjectId, recurrenceString, targetDate) {
  console.log(`  Self-testing pattern ${JSON.stringify(recurrenceString)} → target ${targetDate}...`);
  const created = await todoist(token, "/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "TEST bulk-reschedule-tasks self-check — delete me",
      project_id: kidsProjectId,
      due_string: recurrenceString,
    }),
  });

  try {
    await rescheduleViaDueString(token, created.id, recurrenceString, targetDate);
    const after = await todoist(token, `/tasks/${encodeURIComponent(created.id)}`);

    // targetDate is deliberately date-only (see call site) even for a timed pattern
    // like "every day at 6pm" — comparing just the date portion of what came back
    // is the correct check here; the time-of-day is the pattern's own concern, not
    // something this self-test controls or needs to re-verify.
    const gotDate = after.due?.date ?? null;
    const wantDate = targetDate;
    const ok =
      gotDate?.slice(0, 10) === wantDate && after.due?.is_recurring === true && after.due?.string === recurrenceString;

    if (!ok) {
      fail(
        `Self-test failed for pattern ${JSON.stringify(recurrenceString)}: ` +
          `expected due.date ${JSON.stringify(wantDate)} with is_recurring=true and string unchanged, ` +
          `got due=${JSON.stringify(after.due)}. This usually means the "starting <date>" reconstruction ` +
          `landed on a different occurrence than requested for this pattern (see this file's header comment) — ` +
          `nothing in the real plan was touched. Investigate by hand before re-running.`
      );
    }
    console.log(`    ✓ landed exactly on ${gotDate}, recurrence intact`);
  } finally {
    await todoist(token, `/tasks/${encodeURIComponent(created.id)}`, { method: "DELETE" }).catch(() => {});
  }
}

async function main() {
  const [, , planPath, flag] = process.argv;
  if (!planPath) fail("Usage: node scripts/bulk-reschedule-tasks.mjs <plan.json> [--apply]");
  const apply = flag === "--apply";

  const token = (await loadDevVar("TODOIST_TOKEN")) ?? process.env.TODOIST_TOKEN;
  if (!token) fail("No TODOIST_TOKEN found in .dev.vars or the environment.");
  const kidsProjectId = await loadWranglerVar("KIDS_PROJECT_ID");
  if (!kidsProjectId) fail("Couldn't find KIDS_PROJECT_ID in wrangler.toml.");

  const plan = JSON.parse(await readFile(planPath, "utf8"));
  if (!Array.isArray(plan) || plan.length === 0) fail("Plan file must be a non-empty JSON array.");
  for (const entry of plan) {
    if (!entry.id || !entry.date) fail(`Every plan entry needs an "id" and a "date": ${JSON.stringify(entry)}`);
  }

  console.log(`Loaded ${plan.length} plan entries from ${planPath}. Fetching current state from Todoist...\n`);

  const current = [];
  for (const entry of plan) {
    const task = await todoist(token, `/tasks/${encodeURIComponent(entry.id)}`);
    assertOwned(task, kidsProjectId, entry.label ?? entry.id);
    if (!task.due?.is_recurring) {
      fail(
        `Task ${entry.id} (${task.content}) isn't recurring — this script is only for rescheduling recurring tasks.`
      );
    }
    current.push({ entry, task });
  }

  console.log("Dry run — current → planned:\n");
  for (const { entry, task } of current) {
    const label = entry.label ? ` (${entry.label})` : "";
    console.log(`  ${task.content}${label}`);
    console.log(`    recurrence: ${task.due.string}`);
    console.log(`    ${task.due.date}  →  ${entry.date}\n`);
  }

  if (!apply) {
    console.log(
      `Dry run only — nothing was changed. Re-run with --apply to actually reschedule these ${plan.length} tasks.`
    );
    return;
  }

  await mkdir(BACKUP_DIR, { recursive: true });
  const backupPath = join(BACKUP_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(
    backupPath,
    JSON.stringify(
      current.map(({ task }) => ({ id: task.id, content: task.content, due: task.due })),
      null,
      2
    )
  );
  console.log(`Backup of current state written to ${backupPath}\n`);

  const patterns = [
    ...new Map(
      current.map(({ task, entry }) => [task.due.string, { pattern: task.due.string, date: entry.date }])
    ).values(),
  ];
  console.log(
    `Self-testing ${patterns.length} distinct recurrence pattern(s) against a throwaway task before touching anything real...\n`
  );
  for (const { pattern, date } of patterns) {
    await selfTestPattern(token, kidsProjectId, pattern, date.slice(0, 10));
  }

  console.log(`\nAll patterns self-tested clean. Applying to the real ${plan.length} tasks...\n`);
  for (const { entry, task } of current) {
    await rescheduleViaDueString(token, task.id, task.due.string, entry.date);
    const after = await todoist(token, `/tasks/${encodeURIComponent(task.id)}`);
    if (after.due?.date !== entry.date || after.due?.is_recurring !== true) {
      fail(
        `Applied ${task.content} (${task.id}) but the result didn't match: expected due.date ${entry.date}, ` +
          `got ${JSON.stringify(after.due)}. STOPPING HERE — earlier tasks in this run were already changed; ` +
          `see ${backupPath} to see what they looked like before, and reconcile by hand.`
      );
    }
    console.log(`  ✓ ${task.content} → ${entry.date}`);
  }

  console.log(`\nDone. All ${plan.length} tasks rescheduled and verified. Backup: ${backupPath}`);
}

// The only place that actually exits — by the time an error/fail() reaches
// here, every enclosing try/finally (e.g. selfTestPattern's cleanup) has
// already run during normal exception unwinding.
main().catch((err) => {
  console.error(`\n✖ ${err.stack ?? String(err)}`);
  process.exit(1);
});
