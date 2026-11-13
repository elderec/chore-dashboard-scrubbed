#!/usr/bin/env node
// Regenerate public/school-calendar.json from your school district's public
// iCal feed. The dashboard's calendar-aware chore skip (SCHOOL_SKIP_* in
// src/index.ts) reads the committed JSON file at runtime — never the ICS directly
// — so this script is how that file gets refreshed: once to seed it, then once a
// year when a new school-year calendar is published (or after a snow make-up day
// is added). Everything it produces lands in a normal `git diff` for review.
//
// The feed: https://example.com/district-calendar.ics
//   - 302-redirects to a cached copy; text/calendar; "District Calendar".
//   - No-school days are all-day VEVENTs whose SUMMARY starts "No School - ",
//     one VEVENT per day even across multi-day breaks (no RRULE / no DTEND range
//     expansion needed). The reason text after the prefix becomes the per-date
//     label used in the Telegram notice / nightly digest line.
//
// Usage:
//   node scripts/refresh-school-calendar.mjs            # fetch, write public/school-calendar.json
//   node scripts/refresh-school-calendar.mjs --dry-run  # print what would be written, don't write
//   node scripts/refresh-school-calendar.mjs --url <ics-url>   # override the feed URL
//   node scripts/refresh-school-calendar.mjs --out <path>      # override the output path
//   node scripts/refresh-school-calendar.mjs --since 2026-08-01 # keep only dates >= this (default: 30 days ago)
//
// The feed carries prior school years too; by default anything more than ~30 days
// stale is dropped so a re-run naturally sheds last year's dates. Stale dates in
// the file are harmless at runtime anyway (they can never equal "today").
//
// `termStart` / `termEnd` in the output file are hand-maintained (the first and
// last student day) and this script only PRESERVES them across a refresh — it
// doesn't compute them. Any date outside that window is treated as no-school,
// which is how the summer break gets covered. See issue #18.
//
// No credentials, no external deps — just fetch + a tiny hand-rolled ICS reader.

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = "https://example.com/district-calendar.ics";
const NO_SCHOOL_PREFIX = /^No School\s*[-–]\s*/i;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** Unfold RFC 5545 line continuations (a line starting with space or tab is a
 * continuation of the previous one) and return logical lines. */
function unfold(ics) {
  const out = [];
  for (const raw of ics.split(/\r?\n/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += raw.slice(1);
    } else {
      out.push(raw);
    }
  }
  return out;
}

/** Pull { date: "YYYY-MM-DD", label } for every VEVENT whose SUMMARY marks a
 * no-school day. Later duplicates for the same date keep the first label. */
function parseNoSchoolDays(ics) {
  const byDate = new Map();
  let inEvent = false;
  let summary = null;
  let date = null;

  for (const line of unfold(ics)) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      summary = null;
      date = null;
      continue;
    }
    if (line === "END:VEVENT") {
      if (inEvent && date && summary && NO_SCHOOL_PREFIX.test(summary)) {
        const label = summary.replace(NO_SCHOOL_PREFIX, "").trim();
        if (!byDate.has(date)) byDate.set(date, label);
      }
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;

    if (line.startsWith("SUMMARY")) {
      summary = line.slice(line.indexOf(":") + 1).trim();
    } else if (line.startsWith("DTSTART")) {
      // "DTSTART;VALUE=DATE:20261111" (all-day) or "DTSTART:20261111T..." (timed).
      const value = line.slice(line.indexOf(":") + 1).trim();
      const m = value.match(/^(\d{4})(\d{2})(\d{2})/);
      if (m) date = `${m[1]}-${m[2]}-${m[3]}`;
    }
  }

  return byDate;
}

async function main() {
  const url = arg("--url") ?? DEFAULT_URL;
  const outPath = arg("--out") ?? join(repoRoot, "public", "school-calendar.json");
  const dryRun = process.argv.includes("--dry-run");

  process.stderr.write(`Fetching ${url}\n`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Feed fetch failed: ${res.status} ${res.statusText}`);
  }
  const ics = await res.text();

  const byDate = parseNoSchoolDays(ics);
  if (byDate.size === 0) {
    throw new Error("Parsed 0 no-school days — the feed format may have changed; refusing to write an empty calendar.");
  }

  const since = arg("--since") ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const d of [...byDate.keys()]) if (d < since) byDate.delete(d);
  if (byDate.size === 0) {
    throw new Error(`Parsed no-school days but all are before --since ${since}; nothing to write.`);
  }

  const skipDates = [...byDate.keys()].sort();
  const labels = Object.fromEntries(skipDates.map((d) => [d, byDate.get(d)]));

  // termStart / termEnd are hand-maintained (a parent knows the first/last day of
  // school): carry forward whatever's already in the file, else write null with a
  // reminder. Any date outside [termStart, termEnd] is treated as no-school too —
  // that's what covers the summer break, which the feed doesn't enumerate. (An
  // auto-derive from the feed's own "First day for students" / "Last Day for
  // students" events is issue #18 Option B.)
  let termStart = null;
  let termEnd = null;
  try {
    const existing = JSON.parse(await readFile(outPath, "utf8"));
    if (typeof existing.termStart === "string") termStart = existing.termStart;
    if (typeof existing.termEnd === "string") termEnd = existing.termEnd;
  } catch {
    /* no existing file / unreadable — leave both null */
  }
  if (!termStart || !termEnd) {
    process.stderr.write(
      "\n⚠  termStart/termEnd not set in the existing file — fill them in (first/last student day) " +
        "or out-of-term dates (summer, etc.) won't be skipped.\n"
    );
  }

  const file = {
    $comment: `Your school district no-school days, generated by scripts/refresh-school-calendar.mjs from ${url} on ${new Date().toISOString().slice(0, 10)}. Weekends are handled by Todoist recurrence, not listed here. termStart/termEnd (hand-maintained) bracket the school year — any date outside them counts as no-school too, which is how summer break is covered. Re-run the script to refresh skipDates; it preserves termStart/termEnd.`,
    termStart,
    termEnd,
    skipDates,
    labels,
  };
  const json = JSON.stringify(file, null, 2) + "\n";

  process.stderr.write(
    `Parsed ${skipDates.length} no-school days (${skipDates[0]} … ${skipDates[skipDates.length - 1]})\n`
  );
  for (const d of skipDates) process.stderr.write(`  ${d}  ${labels[d]}\n`);

  if (dryRun) {
    process.stderr.write("\n--dry-run: not writing.\n");
    process.stdout.write(json);
    return;
  }

  await writeFile(outPath, json);
  process.stderr.write(`\nWrote ${outPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  process.exit(1);
});
