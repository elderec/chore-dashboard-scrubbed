// Kiosk frontend for the chore dashboard. No framework, no modules — plain
// ES5-ish JS (var, function expressions) loaded via a single <script src>, so
// everything lives in one IIFE to avoid leaking the state below (kids,
// lastGroups, etc.) onto the page's global scope.
//
// Rough map, top to bottom:
//   - shared state (kids, poll/tab/override tracking)
//   - clock, sun-based theme, Day/Evening tab-slot logic
//   - Fully Kiosk integration (window.fully) — brightness, keep-awake,
//     night schedule/motion wake, all opt-in via wrangler.toml
//   - weather (Open-Meteo)
//   - board rendering: buildColumns/render (chore cards) and renderStreaks
//   - tap handling (onCardTap) and the auth-error state
//   - poll() — the 45s loop that drives everything above, plus bootstrap at
//     the bottom
(function () {
  var KEY = new URLSearchParams(location.search).get("key") || "";
  var POLL_MS = 45000;
  // [{key, name, color}], from the first successful /api/chores response --
  // the dashboard doesn't hardcode who it's for. See KIDS in wrangler.toml.
  var kids = null;

  // Weather location — null until the first successful /api/chores poll
  // reports it (data.weather, from wrangler.toml's WEATHER_LAT/WEATHER_LON).
  var weatherLocation = null;
  var WEATHER_POLL_MS = 30 * 60 * 1000; // weather doesn't need 45s freshness

  // Today's sunrise/sunset as epoch ms, refreshed alongside weather; null until the
  // first weather fetch resolves, so the theme starts dark (the :root default) and
  // switches to light-if-daytime as soon as real sun times are known.
  var sunTimes = null;

  // Fully Kiosk integration config — null until the first successful
  // /api/chores poll reports it (see wrangler.toml's USE_FULLY_KIOSK and
  // FULLY_* vars, threaded through as data.fullyKiosk). null is treated the
  // same as "everything off", same spirit as eveningStartsAtMinutes staying
  // null pre-first-poll.
  var fullyConfig = null;
  var fullyScreenForcedOff = false;
  var fullyLastMotionAt = 0;

  // Day/Evening tab state — all null until the first successful /api/chores
  // poll reports eveningStartsAtMinutes (see wrangler.toml's EVENING_STARTS_AT).
  // activeSlot is what's currently displayed; lastAutoSlot is what the real
  // clock says it should be right now, tracked separately so a manual tap can
  // stick without being immediately fought by the next 15s clock tick — see
  // updateActiveSlot().
  var eveningStartsAtMinutes = null;
  var activeSlot = null;
  var lastAutoSlot = null;

  // taskId -> "done" | "open" (optimistic overrides, cleared once server state agrees)
  var localOverrides = {};
  // taskId -> true while a complete/reopen request for it is in flight (debounce rapid taps)
  var pendingIds = {};
  // taskId -> true for one render cycle right after completing, to trigger the celebration
  var justCompletedIds = {};
  var lastGroups = null;
  var consecutiveFailures = 0;
  // Set once a 403 confirms the key baked into this page load is wrong — stops
  // the poll loop entirely, since retrying can't ever fix that without a reload.
  var authFailed = false;

  // ---- small helpers ----

  function apiUrl(path) {
    var sep = path.indexOf("?") === -1 ? "?" : "&";
    return path + sep + "key=" + encodeURIComponent(KEY);
  }

  function setStatusBanner(visible) {
    document.getElementById("status-banner").classList.toggle("visible", visible);
  }

  var actionToastTimer = null;

  /** Shows a short message at the bottom of the screen for 6s — used when a tap's
   * request failed, so the chore popping back isn't a silent mystery. */
  function showActionToast(message) {
    var el = document.getElementById("action-toast");
    el.textContent = message;
    el.classList.add("visible");
    clearTimeout(actionToastTimer);
    actionToastTimer = setTimeout(function () {
      el.classList.remove("visible");
    }, 6000);
  }

  // ---- clock, sun-based theme, Day/Evening tab-slot logic ----

  function ordinal(n) {
    var suffixes = ["th", "st", "nd", "rd"];
    var v = n % 100;
    return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
  }

  function updateClock() {
    var now = new Date();

    var timeOpts = { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" };
    document.getElementById("clock").textContent = now.toLocaleTimeString("en-US", timeOpts);

    var dateOpts = { month: "long", day: "numeric", timeZone: "America/New_York" };
    var parts = new Intl.DateTimeFormat("en-US", dateOpts).formatToParts(now);
    var month = parts.filter(function (p) {
      return p.type === "month";
    })[0].value;
    var day = Number(
      parts.filter(function (p) {
        return p.type === "day";
      })[0].value
    );
    document.getElementById("date").textContent = month + " " + ordinal(day);

    applyTheme(now);
    updateActiveSlot(now);
    updateFullyScreenSchedule(now);
  }

  function applyTheme(now) {
    if (!sunTimes) return; // no sun data yet — stay on the dark default until the first weather fetch lands
    var isDay = now.getTime() >= sunTimes.sunrise && now.getTime() < sunTimes.sunset;
    document.documentElement.setAttribute("data-theme", isDay ? "light" : "dark");
    if (fullyReady() && fullyConfig.brightnessEnabled) {
      callFully(function () {
        window.fully.screenBrightness(isDay ? fullyConfig.dayBrightness : fullyConfig.nightBrightness);
      });
    }
  }

  // Minutes since local midnight, America/New_York — same zone the server
  // used to compute each chore's dueTimeMinutes, so these are directly comparable.
  function currentSlotMinutes(now) {
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
    var hour = Number(
      parts.filter(function (p) {
        return p.type === "hour";
      })[0].value
    );
    var minute = Number(
      parts.filter(function (p) {
        return p.type === "minute";
      })[0].value
    );
    return hour * 60 + minute;
  }

  function slotFor(minutes) {
    return minutes < eveningStartsAtMinutes ? "day" : "evening";
  }

  // e.g. 0 -> "12a", 960 -> "4p" — used for the tab labels, derived from
  // eveningStartsAtMinutes rather than a hardcoded string.
  function shortTime(minutes) {
    var h = Math.floor(minutes / 60);
    var ampm = h >= 12 ? "p" : "a";
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ampm;
  }

  /** Runs once, the first time eveningStartsAtMinutes is known (mirrors
   * buildColumns) — creates the two tab buttons and wires their click handlers. */
  function buildSlotRow() {
    var row = document.getElementById("slot-row");
    row.innerHTML = "";
    var toggle = document.createElement("div");
    toggle.className = "slot-toggle";

    [
      { slot: "day", icon: "☀️", label: "Day", range: shortTime(0) + "–" + shortTime(eveningStartsAtMinutes) },
      {
        slot: "evening",
        icon: "🌙",
        label: "Evening",
        range: shortTime(eveningStartsAtMinutes) + "–" + shortTime(0),
      },
    ].forEach(function (def) {
      var btn = document.createElement("button");
      btn.className = "slot-btn";
      btn.setAttribute("data-slot", def.slot);
      var dot = document.createElement("span");
      dot.className = "now-dot";
      var range = document.createElement("span");
      range.className = "range";
      range.textContent = def.range;
      btn.appendChild(dot);
      btn.appendChild(document.createTextNode(def.icon + " " + def.label + " "));
      btn.appendChild(range);
      btn.addEventListener("click", function () {
        activeSlot = def.slot;
        updateSlotRowUI();
        if (lastGroups) render(lastGroups);
      });
      toggle.appendChild(btn);
    });

    row.appendChild(toggle);
    updateSlotRowUI();
  }

  /** Cheap, idempotent — just toggles classes on the two existing buttons.
   * Safe to call on every clock tick without rebuilding anything. */
  function updateSlotRowUI() {
    document.querySelectorAll(".slot-btn").forEach(function (btn) {
      var slot = btn.getAttribute("data-slot");
      var isActive = slot === activeSlot;
      btn.classList.toggle("active", isActive);
      btn.classList.toggle("is-now", slot === lastAutoSlot);
      // .active is CSS-only otherwise — without this, a screen reader announces
      // both tab buttons identically, with no indication of which is showing.
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  /** Re-checked every clock tick (see updateClock). Only forces activeSlot to
   * follow the real clock at the moment the real slot actually changes — e.g.
   * a kid who taps "Day" while it's evening keeps seeing Day until the schedule
   * itself moves on to the next real transition, rather than the very next 15s
   * tick immediately snapping back to Evening. */
  function updateActiveSlot(now) {
    if (eveningStartsAtMinutes === null) return; // not known yet — before the first successful poll
    var nowSlot = slotFor(currentSlotMinutes(now));
    if (nowSlot !== lastAutoSlot) {
      lastAutoSlot = nowSlot;
      activeSlot = nowSlot;
      updateSlotRowUI();
      if (lastGroups) render(lastGroups);
    } else {
      updateSlotRowUI();
    }
  }

  // ---- Fully Kiosk integration (window.fully) ----
  //
  // Everything here is a no-op unless BOTH fullyConfig.enabled is true AND the
  // browser actually exposes window.fully (see fullyReady()) — on any other
  // browser/kiosk app, or with the master switch off, none of this runs. Each
  // of the three features below is additionally gated by its own enable flag
  // (fullyConfig.brightnessEnabled/dayKeepawakeEnabled/nightScheduleEnabled),
  // so any one can be on without the others. See wrangler.toml's USE_FULLY_KIOSK
  // and FULLY_* vars, and README's "Fully Kiosk integration" section.

  function fullyReady() {
    return !!fullyConfig && fullyConfig.enabled && typeof window.fully !== "undefined";
  }

  // Every window.fully.* call goes through this. This project can't verify
  // Fully's real JS API surface without a real tablet, so a single mismatch
  // (wrong method name, a method unsupported on this Fully version, etc.)
  // must never throw uncaught and break anything downstream of it — this
  // broke the live dashboard once already (a bad diagnostic call aborted the
  // rest of poll()'s response handler, taking chore/streak rendering down
  // with it) before this wrapper existed.
  function callFully(fn) {
    try {
      fn();
    } catch (err) {
      console.error("window.fully call failed", err);
    }
  }

  function hhmmToMinutes(hhmm) {
    var parts = hhmm.split(":").map(Number);
    return parts[0] * 60 + parts[1];
  }

  // Handles the midnight wraparound (e.g. 23:00–05:00) that slotFor()'s
  // simple single-boundary comparison doesn't need to.
  function inNightWindow(minutes) {
    var offMin = hhmmToMinutes(fullyConfig.nightScreenOffAt);
    var onMin = hhmmToMinutes(fullyConfig.nightScreenOnAt);
    if (offMin <= onMin) return minutes >= offMin && minutes < onMin;
    return minutes >= offMin || minutes < onMin;
  }

  /** One-time setup, called once fullyConfig is known (see poll()) — so the
   * very first clock tick doesn't leave the screen unprotected for up to 15s. */
  function initFullyKiosk() {
    if (fullyReady() && fullyConfig.dayKeepawakeEnabled) {
      callFully(function () {
        window.fully.keepScreenOn(true);
      });
    }
  }

  // Ticked every 15s from updateClock(), same as applyTheme/updateActiveSlot.
  // Day keep-awake and the night schedule are checked independently — either
  // can be on without the other (e.g. night-schedule on with day-keepawake
  // left off just relies on Fully's own device-level "Keep Screen On" setting
  // by day).
  function updateFullyScreenSchedule(now) {
    if (!fullyReady()) return;
    var inNight = fullyConfig.nightScheduleEnabled && inNightWindow(currentSlotMinutes(now));

    if (!inNight) {
      if (fullyScreenForcedOff) {
        callFully(function () {
          window.fully.screenOn();
        });
        fullyScreenForcedOff = false;
      }
      if (fullyConfig.dayKeepawakeEnabled) {
        callFully(function () {
          window.fully.keepScreenOn(true);
        });
      }
      return;
    }

    // Only reachable at all when fullyConfig.nightScheduleEnabled is true.
    var graceMs = fullyConfig.motionWakeGraceMinutes * 60 * 1000;
    var recentMotion = Date.now() - fullyLastMotionAt < graceMs;
    if (recentMotion) {
      if (fullyScreenForcedOff) {
        callFully(function () {
          window.fully.screenOn();
        });
        fullyScreenForcedOff = false;
      }
      return;
    }

    if (!fullyScreenForcedOff) {
      callFully(function () {
        window.fully.keepScreenOn(false); // stop fighting screenOff() below
        window.fully.screenOff();
      });
      fullyScreenForcedOff = true;
    }
  }

  // Fully Kiosk calls this global function directly when Motion Detection is
  // enabled and the JS Interface is on.
  window.motionDetected = function () {
    fullyLastMotionAt = Date.now();
    if (fullyScreenForcedOff && fullyReady() && fullyConfig.nightScheduleEnabled) {
      callFully(function () {
        window.fully.screenOn();
      });
      fullyScreenForcedOff = false;
    }
  };

  // ---- weather (Open-Meteo) ----

  // code is Open-Meteo's WMO weather_code — see
  // https://open-meteo.com/en/docs#weathervariables for the full table; these
  // are just the ranges that map to a meaningfully different emoji.
  function weatherIcon(code, isDay) {
    if (code === 0) return isDay ? "☀️" : "🌙";
    if (code === 1 || code === 2) return isDay ? "🌤️" : "☁️";
    if (code === 3) return "☁️";
    if (code === 45 || code === 48) return "🌫️";
    if (code >= 51 && code <= 57) return "🌦️";
    if (code >= 61 && code <= 67) return "🌧️";
    if (code >= 71 && code <= 77) return "❄️";
    if (code >= 80 && code <= 82) return "🌧️";
    if (code === 85 || code === 86) return "🌨️";
    if (code >= 95) return "⛈️";
    return "🌡️";
  }

  function updateWeather() {
    var url =
      "https://api.open-meteo.com/v1/forecast?latitude=" +
      weatherLocation.lat +
      "&longitude=" +
      weatherLocation.lon +
      "&current=temperature_2m,weather_code,is_day" +
      "&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset" +
      "&temperature_unit=fahrenheit&timezone=America%2FNew_York&timeformat=unixtime&forecast_days=1";
    // Without a timeout, a genuinely hung (not merely failing) request never
    // rejects, sunTimes never gets set, and the theme is stuck on its dark
    // default indefinitely — the 30-minute interval below would just pile a
    // second request behind the stuck one rather than replacing it.
    fetch(url, { signal: AbortSignal.timeout(10000) })
      .then(function (res) {
        if (!res.ok) throw new Error("weather fetch failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        var c = data.current;
        var icon = weatherIcon(c.weather_code, c.is_day);
        var temp = Math.round(c.temperature_2m);
        var hi = Math.round(data.daily.temperature_2m_max[0]);
        var lo = Math.round(data.daily.temperature_2m_min[0]);

        var el = document.getElementById("weather");
        el.innerHTML = "";
        var now = document.createElement("div");
        now.className = "weather-now";
        now.textContent = icon + " " + temp + "°F";
        var hilo = document.createElement("div");
        hilo.className = "weather-hilo";
        hilo.textContent = "H:" + hi + "°  L:" + lo + "°";
        el.appendChild(now);
        el.appendChild(hilo);

        // sunrise/sunset come back as unix seconds (timeformat=unixtime), which
        // sidesteps any ambiguity about which timezone a bare local time string
        // like "2026-08-22T06:42" would be parsed in by the tablet's own JS engine.
        sunTimes = {
          sunrise: data.daily.sunrise[0] * 1000,
          sunset: data.daily.sunset[0] * 1000,
        };
        applyTheme(new Date());
      })
      .catch(function () {
        // leave whatever weather was last shown rather than blanking it on a hiccup
      });
  }

  // ---- board rendering: columns, chore cards, streaks ----

  /** A kid's avatar — always attempts to load their photo (GET
   * /api/avatars/<kid.key> — no extension in the URL itself, the server adds
   * ".jpg" when it builds the R2 object key, see handleGetAvatar in
   * src/index.ts — authenticated the same as every other request), falling
   * back to a colored circle with their first initial if
   * it fails to load (no photo uploaded yet, or none at all — AVATARS is
   * optional infra server-side, see handleGetAvatar in src/index.ts). The
   * fallback is always in the DOM underneath the photo, so a failed/missing
   * photo never shows a broken-image icon — it just quietly reveals the
   * fallback that was there all along. */
  function buildAvatar(kid) {
    var wrap = document.createElement("div");
    wrap.className = "avatar-wrap";
    wrap.setAttribute("data-avatar", kid.key); // same data-* addressing convention as data-list/data-sub/data-streak

    var fallback = document.createElement("div");
    fallback.className = "avatar-fallback";
    fallback.style.setProperty("--kid-color", kid.color);
    fallback.textContent = kid.name.charAt(0).toUpperCase();
    wrap.appendChild(fallback);

    var img = document.createElement("img");
    img.className = "avatar-photo";
    img.alt = kid.name;
    // CSP here is script-src 'self' (see public/_headers) — an inline
    // onerror="..." attribute would be blocked as an inline script, so this
    // has to be a real addEventListener from app.js, not an HTML attribute.
    img.addEventListener("error", function () {
      img.remove(); // leaves the fallback circle showing underneath
    });
    img.src = apiUrl("/api/avatars/" + kid.key);
    wrap.appendChild(img);

    return wrap;
  }

  /** Builds one column per configured kid — runs once, the first time the
   * kid list is known (from the API response), replacing the loading state. */
  function buildColumns(newKids) {
    kids = newKids;
    var board = document.getElementById("board");
    board.innerHTML = "";
    board.style.gridTemplateColumns = "repeat(" + kids.length + ", 1fr)";

    kids.forEach(function (kid) {
      var section = document.createElement("section");
      section.className = "column";
      section.style.setProperty("--kid-color", kid.color);

      var header = document.createElement("div");
      header.className = "column-header";
      var nameRow = document.createElement("div");
      nameRow.className = "name-row";
      var h2 = document.createElement("h2");
      h2.textContent = kid.name;
      nameRow.appendChild(buildAvatar(kid));
      nameRow.appendChild(h2);
      var sub = document.createElement("div");
      sub.className = "column-sub";
      sub.setAttribute("data-sub", kid.key);
      var streakRow = document.createElement("div");
      streakRow.className = "streak-row";
      streakRow.setAttribute("data-streak", kid.key);
      header.appendChild(nameRow);
      header.appendChild(sub);
      header.appendChild(streakRow);

      var list = document.createElement("div");
      list.className = "chore-list";
      list.setAttribute("data-list", kid.key);
      // render() fully rebuilds this list's contents, but only when the data
      // actually changed (see poll()'s `changed` check) — so this only speaks
      // up on real chore changes, not every idle 45s poll.
      list.setAttribute("aria-live", "polite");

      section.appendChild(header);
      section.appendChild(list);
      board.appendChild(section);
    });
  }

  function render(groups) {
    kids.forEach(function (kid) {
      var all = groups[kid.key] || [];
      // A chore with no time set (dueTimeMinutes null) shows in both tabs —
      // safe default while chores are still being migrated to have real times;
      // nothing silently disappears just because it hasn't gotten a time yet.
      // An overdue chore also shows in both tabs regardless of which slot it's
      // assigned to — once something's overdue, its original slot stops being
      // the relevant fact about it ("this needs attention" outranks "this was
      // scheduled for evening"); a kid checking Day in the morning should see
      // an unfinished chore from last night, not just a vague count of it.
      var list = all.filter(function (c) {
        return c.dueTimeMinutes === null || c.isOverdue || slotFor(c.dueTimeMinutes) === activeSlot;
      });
      var listEl = document.querySelector('[data-list="' + kid.key + '"]');
      var subEl = document.querySelector('[data-sub="' + kid.key + '"]');

      var remaining = list.filter(function (c) {
        return localOverrides[c.id] !== "done" && !c._done;
      }).length;
      subEl.textContent = list.length === 0 ? "" : remaining === 0 ? "All done! 🎉" : remaining + " to go";

      listEl.innerHTML = "";

      if (list.length === 0) {
        var empty = document.createElement("div");
        empty.className = "empty-state";
        // "Nothing this day/evening" used to be ambiguous — it read like "nothing
        // due today" even when the kid actually has chores due, just in the other
        // tab (all.length > 0 here means exactly that). "Nothing due right now" is
        // accurate either way (nothing needs doing at the moment); naming the
        // other tab and how many chores are waiting there is the useful, specific
        // part. all.length IS the other slot's count in this branch — a no-time
        // or overdue chore always passes the filter above into `list`, so if
        // `list` is empty, everything left in `all` is specifically in the other
        // slot and not yet overdue, nothing extra to compute.
        if (all.length === 0) {
          empty.textContent = "Nothing due right now 🎉";
        } else {
          var otherLabel = activeSlot === "day" ? "Evening" : "Day";
          var otherCount = all.length;
          empty.textContent =
            "Nothing due right now — " +
            otherCount +
            (otherCount === 1 ? " chore" : " chores") +
            " this " +
            otherLabel +
            " 🎉";
        }
        listEl.appendChild(empty);
        return;
      }

      // One DocumentFragment for the whole list, appended to listEl exactly once
      // below, rather than an appendChild(card) per chore straight into the live
      // DOM — this project's real Fully Kiosk Android WebView was observed
      // silently dropping the paint of exactly one card in a several-card list
      // (varies which one, DOM/count stayed correct) when each card triggered
      // its own layout/paint pass in quick succession; batching into a single
      // reflow both fixes that and is the more standard pattern regardless.
      var fragment = document.createDocumentFragment();

      list.forEach(function (chore) {
        var override = localOverrides[chore.id];
        var isDone = override ? override === "done" : !!chore._done;
        var isPending = !!pendingIds[chore.id];
        var isCelebrating = isDone && !!justCompletedIds[chore.id];

        var card = document.createElement("div");
        card.className =
          "chore-card" +
          (isDone ? " done" : "") +
          (!isDone && chore.isOverdue ? " overdue" : "") +
          (isPending ? " pending" : "") +
          (isCelebrating ? " celebrate" : "");
        card.setAttribute("data-id", chore.id);
        // A plain clickable div is invisible to keyboard/switch-access users
        // and screen readers otherwise — role+tabindex+aria-pressed makes this
        // behave like a real toggle button; the keydown handler below is what
        // actually makes Enter/Space work (unlike a real <button>, a div with
        // role="button" doesn't get that for free).
        card.setAttribute("role", "button");
        card.setAttribute("tabindex", "0");
        card.setAttribute("aria-pressed", isDone ? "true" : "false");

        var box = document.createElement("div");
        box.className = "checkbox";
        box.textContent = "✓";
        box.setAttribute("aria-hidden", "true"); // state is already conveyed via the card's aria-pressed
        card.appendChild(box);

        var body = document.createElement("div");
        body.className = "chore-body";

        var title = document.createElement("div");
        title.className = "chore-title";
        title.textContent = chore.title;
        body.appendChild(title);

        if (chore.recurrence) {
          var meta = document.createElement("div");
          meta.className = "chore-meta";
          meta.textContent = chore.recurrence;
          body.appendChild(meta);
        }

        // Rotation handoff (see computeHandoffNote() in src/index.ts): this
        // chore isn't overdue for THIS kid, but a sibling's identically-titled
        // chore still is — display-only, explains why the same title shows up
        // in two columns at once instead of it looking like a data mix-up.
        if (chore.handoffNote) {
          var handoff = document.createElement("div");
          handoff.className = "chore-handoff-note";
          handoff.textContent = "🔁 " + chore.handoffNote;
          body.appendChild(handoff);
        }

        card.appendChild(body);

        if (!isDone && chore.isOverdue) {
          var badge = document.createElement("div");
          badge.className = "overdue-badge";
          // Whole days late when it's a day or more (older cached API responses
          // have no overdueDays, so that falls back to plain "OVERDUE").
          badge.textContent =
            chore.overdueDays > 0
              ? chore.overdueDays + (chore.overdueDays === 1 ? " DAY OVERDUE" : " DAYS OVERDUE")
              : "OVERDUE";
          card.appendChild(badge);
        }

        card.addEventListener("click", function () {
          onCardTap(chore.id, isDone, chore.due);
        });
        card.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
            e.preventDefault(); // Space otherwise scrolls the page
            onCardTap(chore.id, isDone, chore.due);
          }
        });

        fragment.appendChild(card);
      });

      listEl.appendChild(fragment);
    });
  }

  function makeDot(clean, isToday) {
    var dot = document.createElement("span");
    var cls = "hdot";
    if (clean) cls += " done";
    if (clean === null && !isToday) cls += " unknown"; // no tracked data yet (e.g. a kid just added, or the feature just shipped)
    if (isToday) cls += " today";
    dot.className = cls;
    return dot;
  }

  // Independent of render()/lastGroups — streaks only change once a night (when
  // the digest runs), but are re-rendered every poll anyway since it's cheap and
  // keeps this simple, rather than diffing streaks separately from chore groups.
  function renderStreaks(streaks) {
    kids.forEach(function (kid) {
      var data = (streaks && streaks[kid.key]) || { streak: 0, history: [] };
      var row = document.querySelector('[data-streak="' + kid.key + '"]');
      if (!row) return;
      row.innerHTML = "";

      var badge = document.createElement("span");
      badge.className = "streak-badge" + (data.streak > 0 ? " on" : "") + (data.streak >= 5 ? " hot" : "");
      var flame = document.createElement("span");
      flame.className = "flame";
      flame.textContent = "🔥";
      badge.appendChild(flame);
      badge.appendChild(document.createTextNode(data.streak + (data.streak === 1 ? " day" : " days")));
      row.appendChild(badge);

      var dots = document.createElement("div");
      dots.className = "history-dots";
      var recent = data.history.slice(-6); // most recent 6 resolved days
      for (var i = 0; i < 6 - recent.length; i++) dots.appendChild(makeDot(null, false));
      recent.forEach(function (clean) {
        dots.appendChild(makeDot(clean, false));
      });
      dots.appendChild(makeDot(null, true)); // today — always live/in-progress, never read from history
      row.appendChild(dots);
    });
  }

  // ---- tap handling ----

  // dueDate is the chore's due date as of this render — sent back on reopen so the
  // Worker can restore it. Closing a recurring task auto-advances its due date to the
  // next occurrence; Todoist's reopen endpoint only un-marks completion, it doesn't
  // revert that, so undoing a mis-tap needs this to actually put the chore back on
  // today's board instead of it silently vanishing on the next poll.
  function onCardTap(taskId, currentlyDone, dueDate) {
    if (pendingIds[taskId]) return; // debounce: ignore rapid re-taps while a request is in flight
    pendingIds[taskId] = true;

    var nextState = currentlyDone ? "open" : "done";
    localOverrides[taskId] = nextState;

    if (nextState === "done") {
      justCompletedIds[taskId] = true;
      setTimeout(function () {
        delete justCompletedIds[taskId];
      }, 700);
    }

    if (lastGroups) render(lastGroups);

    var action = nextState === "done" ? "complete" : "reopen";
    var options = { method: "POST" };
    if (action === "reopen" && dueDate) {
      options.headers = { "content-type": "application/json" };
      options.body = JSON.stringify({ dueDate: dueDate });
    }
    // true once the server answered at all — a fetch that rejects before that means
    // the request never left the tablet (Wi-Fi down), which a re-tap can't fix
    var reachedServer = false;
    fetch(apiUrl("/api/chores/" + encodeURIComponent(taskId) + "/" + action), options)
      .then(function (res) {
        reachedServer = true;
        if (!res.ok) throw new Error("request failed: " + res.status);
        // keep optimistic state until next successful poll reconciles it
      })
      .catch(function () {
        // revert on failure, and say so — otherwise the card just bounces back unexplained
        delete localOverrides[taskId];
        showActionToast(
          reachedServer
            ? "⚠️ Couldn't save that — tap again, or tell a grown-up if it keeps happening"
            : "📡 The tablet is offline, so that didn't save — tell a grown-up to check the Wi-Fi"
        );
      })
      .finally(function () {
        delete pendingIds[taskId];
        if (lastGroups) render(lastGroups);
      });
  }

  // ---- auth-error state ----

  // A 403 means the key baked into this page load is wrong or missing — unlike a
  // network blip, retrying can never fix that (the key doesn't change without a
  // fresh page load), so this is handled as a distinct, permanent error state
  // rather than folded into the same "Reconnecting…" treatment as a transient
  // failure. Otherwise the board just sits on "Loading chores…" forever while
  // implying a retry might still succeed.
  function showAuthError() {
    authFailed = true;
    setStatusBanner(false);
    var board = document.getElementById("board");
    board.innerHTML = "";
    var msg = document.createElement("div");
    msg.id = "board-loading";
    msg.textContent =
      "⚠️ This dashboard link isn't valid. Check the URL, or ask whoever set this up for the correct link.";
    board.appendChild(msg);
  }

  // ---- poll loop ----

  function poll() {
    fetch(apiUrl("/api/chores"))
      .then(function (res) {
        if (res.status === 403) {
          showAuthError();
          return null;
        }
        if (!res.ok) throw new Error("fetch failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data) return; // showAuthError() already handled this poll — stop here
        // The fetch itself succeeded — clear "Reconnecting…" regardless of whether
        // the response-handling below succeeds, since that's a separate concern
        // (see the try/catch below).
        consecutiveFailures = 0;
        setStatusBanner(false);
        try {
          if (!kids) {
            buildColumns(data.kids);
            // Weather is a separate, unauthenticated call to a third-party API
            // (Open-Meteo) — deliberately not started until the very first
            // /api/chores poll actually succeeds, so a bad/leaked/probed ?key=
            // never burns a request against it for a page that isn't going to
            // work anyway.
            weatherLocation = data.weather;
            updateWeather();
            setInterval(updateWeather, WEATHER_POLL_MS);

            eveningStartsAtMinutes = data.eveningStartsAtMinutes;
            buildSlotRow();
            updateActiveSlot(new Date()); // sets the correct initial activeSlot from the real clock

            fullyConfig = data.fullyKiosk;
            initFullyKiosk();
            updateFullyScreenSchedule(new Date()); // sets the correct initial screen state from the real clock
          }
          // drop overrides once the server itself reflects the same state
          Object.keys(localOverrides).forEach(function (id) {
            var stillPresent = kids.some(function (kid) {
              return (data.groups[kid.key] || []).some(function (c) {
                return c.id === id;
              });
            });
            // if a completed recurring task's next occurrence has a different id, or
            // the task simply no longer shows as due, the override is stale — drop it
            if (!stillPresent) delete localOverrides[id];
          });
          // skip the teardown/rebuild in render() when this poll didn't actually change
          // anything — avoids needless DOM churn every 45s and a poll landing mid-animation
          // from interrupting a card's completion-pop
          var changed = JSON.stringify(data.groups) !== JSON.stringify(lastGroups);
          lastGroups = data.groups;
          if (changed) render(lastGroups);
          renderStreaks(data.streaks);
        } catch (err) {
          // A bug in our own response-handling code, not a network/API failure —
          // the fetch above already succeeded, so this must NOT fall through to the
          // network-failure .catch() below: that would misreport a code bug as
          // "Reconnecting…" (a connectivity problem this isn't) and, since the same
          // bug would keep throwing every poll, would show that misleading banner
          // forever instead of ever explaining what's actually wrong. Logged
          // distinctly instead. Never blocks the next poll — see the unconditional
          // .finally() below. (This is the general backstop; window.fully calls
          // specifically also have their own narrower callFully() wrapper, so one
          // bad Fully call doesn't even prevent the rest of this block from running.)
          console.error("poll() response handling failed", err);
        }
      })
      .catch(function () {
        consecutiveFailures++;
        if (consecutiveFailures >= 2) setStatusBanner(true);
      })
      .finally(function () {
        if (!authFailed) setTimeout(poll, POLL_MS + Math.floor(Math.random() * 3000));
      });
  }

  // ---- bootstrap ----

  updateClock();
  setInterval(updateClock, 15000);
  poll();
})();
