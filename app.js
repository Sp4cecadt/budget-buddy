(() => {
  const STORE = "budget-buddy-v1";
  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const DAY_SHORT = [
    { n: 1, label: "Mon" },
    { n: 2, label: "Tue" },
    { n: 3, label: "Wed" },
    { n: 4, label: "Thu" },
    { n: 5, label: "Fri" },
    { n: 6, label: "Sat" },
    { n: 0, label: "Sun" },
  ];
  const CATS = ["Groceries", "Bingo", "Bills", "Other"];
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  const $ = (id) => document.getElementById(id);
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

  // ----- dates (always local, never UTC) -----
  function now() {
    return new Date();
  }
  function todayISO(d = now()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function parseISO(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(iso, n) {
    const d = parseISO(iso);
    d.setDate(d.getDate() + n);
    return todayISO(d);
  }
  function diffDays(a, b) {
    return Math.round((parseISO(b) - parseISO(a)) / 86400000);
  }
  function formatLongDate(iso) {
    const d = parseISO(iso);
    return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }
  function formatShortDate(iso) {
    const d = parseISO(iso);
    return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }
  function lastPaydayOnOrBefore(today, paydayDow) {
    const d = parseISO(today);
    const back = (d.getDay() - paydayDow + 7) % 7;
    return addDays(today, -back);
  }
  function greetingWord(d = now()) {
    const h = d.getHours();
    if (h < 12) return "morning";
    if (h < 17) return "afternoon";
    return "evening";
  }

  // ----- money -----
  function money(cents) {
    const n = (cents || 0) / 100;
    const abs = Math.abs(n);
    const formatted = Number.isInteger(abs)
      ? abs.toLocaleString("en-AU")
      : abs.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? "−$" : "$") + formatted;
  }
  function parseDollars(str) {
    const clean = String(str).replace(/[^0-9.]/g, "");
    if (!clean) return 0;
    const n = Number(clean);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.round(n * 100);
  }
  function cycleLen(cycle) {
    return cycle === "weekly" ? 7 : 14;
  }
  function cycleWord(cycle) {
    return cycle === "weekly" ? "week" : "fortnight";
  }

  // ----- store -----
  function defaultState() {
    return {
      version: 1,
      settings: null, // { amount, cycle, payday }
      period: null,   // { start, total }
      spends: [],     // { id, date, amount, category }
      greetOn: null,
      pendingPayday: false,
    };
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (!raw) return defaultState();
      const s = JSON.parse(raw);
      if (!s || typeof s !== "object") return defaultState();
      return Object.assign(defaultState(), s);
    } catch {
      return defaultState();
    }
  }
  function save() {
    localStorage.setItem(STORE, JSON.stringify(state));
  }

  let state = load();
  let addDraft = { keys: "", category: "" };
  let pendingAmount = 0;
  let pendingCategory = "";
  let deleteId = null;
  let paydayKeepLeftover = false;

  // ----- period math -----
  function periodInfo(at = todayISO()) {
    const settings = state.settings;
    if (!settings || !state.period) return null;
    const len = cycleLen(settings.cycle);
    const start = state.period.start;
    const next = addDays(start, len);
    const end = addDays(next, -1);
    const dayNum = diffDays(start, at) + 1;
    const daysLeft = diffDays(at, end) + 1;
    const spent = state.spends
      .filter((s) => s.date >= start && s.date < next)
      .reduce((sum, s) => sum + s.amount, 0);
    const left = state.period.total - spent;
    const daily = daysLeft > 0 ? Math.round(left / daysLeft) : 0;
    const todaySpent = state.spends
      .filter((s) => s.date === at)
      .reduce((sum, s) => sum + s.amount, 0);
    return {
      start, end, next, len, dayNum, daysLeft,
      total: state.period.total,
      spent, left, daily, todaySpent,
      due: at >= next,
    };
  }

  function periodSpends() {
    if (!state.period) return [];
    const next = addDays(state.period.start, cycleLen(state.settings.cycle));
    return state.spends
      .filter((s) => s.date >= state.period.start && s.date < next)
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id.localeCompare(a.id)));
  }

  function medianSpend() {
    const amounts = periodSpends().map((s) => s.amount).sort((a, b) => a - b);
    if (!amounts.length) return 0;
    const mid = Math.floor(amounts.length / 2);
    if (amounts.length % 2) return amounts[mid];
    return Math.round((amounts[mid - 1] + amounts[mid]) / 2);
  }

  function isUnusual(amount) {
    if (amount <= 0 || !state.period) return false;
    const spends = periodSpends();
    if (spends.length >= 5) return amount > 3 * medianSpend();
    return amount > Math.round(state.period.total * 0.5);
  }

  function startPeriod(fromDay, total) {
    state.period = { start: lastPaydayOnOrBefore(fromDay, state.settings.payday), total };
    state.pendingPayday = false;
    paydayKeepLeftover = false;
  }

  function checkPaydayFlag() {
    if (!state.settings || !state.period) return;
    const info = periodInfo();
    if (info && info.due) state.pendingPayday = true;
  }

  // ----- render helpers -----
  function showView(id) {
    ["setup", "today", "payday", "settings"].forEach((v) => {
      const el = $("view-" + v);
      if (el) el.hidden = v !== id;
    });
  }
  function closeSheets() {
    ["sheet-add", "sheet-did", "sheet-nudge", "sheet-delete"].forEach((id) => {
      $(id).hidden = true;
    });
  }
  function paintWeekdays(container, selected) {
    container.innerHTML = DAY_SHORT.map((d) =>
      `<button type="button" class="wd${d.n === selected ? " on" : ""}" data-dow="${d.n}">${d.label}</button>`
    ).join("");
  }
  function paydayHint(dow, cycle) {
    const name = DAY_NAMES[dow];
    const len = cycleLen(cycle);
    return `Next payday is ${name}. That’s a ${len}-day ${cycleWord(cycle)}.`;
  }
  function setSegment(root, cycle) {
    root.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("on", b.dataset.cycle === cycle);
    });
  }
  function daysLeftLabel(n) {
    if (n === 1) return "1 day";
    return n + " days";
  }

  function renderSetup() {
    showView("setup");
    closeSheets();
    const s = state._setup || { amount: "", cycle: "fortnightly", payday: 4 };
    state._setup = s;
    $("setup-amount").value = s.amount ? money(s.amount) : "";
    setSegment($("setup-cycle"), s.cycle);
    paintWeekdays($("setup-payday"), s.payday);
    $("setup-payday-hint").textContent = paydayHint(s.payday, s.cycle);
  }

  function renderToday() {
    const info = periodInfo();
    if (!info) return renderSetup();
    if (info.due || state.pendingPayday) return renderPayday();
    showView("today");
    closeSheets();

    const today = todayISO();
    const word = cycleWord(state.settings.cycle);
    $("today-date").textContent = formatLongDate(today);
    $("today-daypill").textContent = `Day ${Math.min(Math.max(info.dayNum, 1), info.len)} of ${info.len}`;
    $("today-left").innerHTML = `<span class="curr">${info.left < 0 ? "−$" : "$"}</span>${money(Math.abs(info.left)).slice(1)}`;
    $("today-cycle-word").textContent = word;
    $("spends-cycle-word").textContent = word;
    $("today-daily").innerHTML = `<strong>${money(Math.max(info.daily, 0))}</strong> a day`;
    $("today-daysleft").textContent = daysLeftLabel(Math.max(info.daysLeft, 0));
    $("today-payday-line").textContent = `Payday ${DAY_NAMES[state.settings.payday]}`;
    const pct = info.total > 0 ? Math.min(100, (info.spent / info.total) * 100) : 0;
    $("today-fill").style.width = pct + "%";
    $("today-spent").textContent = `${money(info.spent)} spent`;
    $("today-budget").textContent = `${money(info.total)} budget`;

    const list = periodSpends();
    const box = $("spend-list");
    if (!list.length) {
      box.innerHTML = `<div class="empty">No spends yet this ${word}.</div>`;
    } else {
      box.innerHTML = list.map((s) => `
        <button type="button" class="spend" data-id="${s.id}">
          <div>
            <div class="what">${escapeHtml(s.category)}</div>
            <div class="when">${formatShortDate(s.date)}</div>
          </div>
          <div class="amt">${money(s.amount)}</div>
        </button>
      `).join("");
    }

    const greet = $("greet");
    const shouldShow = state.greetOn !== today;
    greet.hidden = !shouldShow;
    if (shouldShow) {
      $("greet-msg").innerHTML = `Good ${greetingWord()}! You can spend <strong>${money(Math.max(info.daily, 0))}</strong> today.`;
    }
  }

  function leftoverCents() {
    const info = periodInfo();
    if (!info) return 0;
    // If we're past the period, leftover is whatever was left at period end.
    return Math.max(info.left, 0);
  }

  function upcomingPeriod(total) {
    const today = todayISO();
    const start = lastPaydayOnOrBefore(today, state.settings.payday);
    const len = cycleLen(state.settings.cycle);
    const next = addDays(start, len);
    const end = addDays(next, -1);
    const daysLeft = Math.max(diffDays(today, end) + 1, 1);
    const daysUntilNext = Math.max(diffDays(today, next), 0);
    const daily = Math.round(total / daysLeft);
    return { start, next, end, daysLeft, daysUntilNext, daily, len };
  }

  function inDays(n) {
    return n === 1 ? "in 1 day" : `in ${n} days`;
  }

  function renderPayday() {
    showView("payday");
    closeSheets();
    const settings = state.settings;
    const word = cycleWord(settings.cycle);
    const leftover = leftoverCents();
    const base = settings.amount;
    const total = paydayKeepLeftover ? base + leftover : base;
    const upcoming = upcomingPeriod(total);

    $("payday-date").textContent = formatLongDate(todayISO());
    $("payday-lede").textContent = leftover && !paydayKeepLeftover
      ? `Your new ${money(base)} is ready for the next ${word}.`
      : `Your new ${money(total)} is ready for the next ${word}.`;
    $("payday-amount").innerHTML = `<span class="curr">$</span>${money(total).slice(1)}`;
    $("payday-daily").textContent = `That’s ${money(upcoming.daily)} a day if you spread it out. Next payday is ${DAY_NAMES[settings.payday]}, ${inDays(upcoming.daysUntilNext)}.`;
    $("payday-stat-daily").textContent = money(upcoming.daily);
    $("payday-stat-days").textContent = `a day for ${daysLeftLabel(upcoming.daysLeft)}`;
    $("payday-stat-day").textContent = DAY_SHORT.find((d) => d.n === settings.payday).label;
    $("payday-stat-cycle").textContent = `payday every ${word}`;
    $("payday-start").textContent = `Start this ${word}`;

    const row = $("payday-roll-row");
    if (leftover > 0) {
      row.hidden = false;
      $("payday-roll-label").textContent = `Keep leftover ${money(leftover)}`;
      $("payday-roll").classList.toggle("on", paydayKeepLeftover);
      $("payday-roll").setAttribute("aria-pressed", paydayKeepLeftover ? "true" : "false");
    } else {
      row.hidden = true;
      paydayKeepLeftover = false;
    }
  }

  function renderSettings() {
    showView("settings");
    closeSheets();
    const s = state._edit || {
      amount: state.settings.amount,
      cycle: state.settings.cycle,
      payday: state.settings.payday,
    };
    state._edit = s;
    $("set-amount").value = s.amount ? money(s.amount) : "";
    setSegment($("set-cycle"), s.cycle);
    paintWeekdays($("set-payday"), s.payday);
    $("set-payday-hint").textContent = paydayHint(s.payday, s.cycle);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ----- add spend -----
  function formatDraft(keys) {
    if (!keys) return "0";
    if (keys.startsWith(".")) return "0" + keys;
    return keys;
  }
  function draftCents() {
    return parseDollars(formatDraft(addDraft.keys));
  }
  function paintAdd() {
    const cents = draftCents();
    const el = $("add-amt");
    if (!addDraft.keys) {
      el.textContent = "$0";
      el.classList.add("placeholder");
    } else {
      el.textContent = money(cents);
      el.classList.remove("placeholder");
    }
    $("add-cats").innerHTML = CATS.map((c) =>
      `<button type="button" class="chip${addDraft.category === c ? " on" : ""}" data-cat="${c}">${c}</button>`
    ).join("");
    const info = periodInfo();
    const after = $("add-after");
    after.classList.remove("warn");
    if (info && cents > 0) {
      const left = info.left - cents;
      const days = Math.max(info.daysLeft, 1);
      const daily = Math.round(left / days);
      after.textContent = `After this you’ll have ${money(left)} left — ${money(Math.max(daily, 0))} a day for ${daysLeftLabel(days)}.`;
    } else {
      after.textContent = "";
    }
    const label = cents ? `Add ${money(cents)}` : "Add";
    $("add-save").textContent = label;
  }

  function openAdd() {
    addDraft = { keys: "", category: "" };
    paintAdd();
    $("sheet-add").hidden = false;
  }

  function typeKey(k) {
    let keys = addDraft.keys;
    if (k === "DEL") {
      keys = keys.slice(0, -1);
    } else if (k === ".") {
      if (!keys.includes(".")) keys = (keys || "0") + ".";
    } else {
      if (keys.includes(".")) {
        const dec = keys.split(".")[1] || "";
        if (dec.length >= 2) return;
      }
      if (keys === "0") keys = k;
      else keys += k;
    }
    // cap at a generous amount so a typo like 4500 still works, but not 15 digits
    if (keys.replace(".", "").length > 8) return;
    addDraft.keys = keys;
    paintAdd();
  }

  function trySaveSpend() {
    const amount = draftCents();
    const category = addDraft.category;
    if (amount <= 0) return;
    if (!category) {
      const warn = $("add-after");
      warn.innerHTML = '<span class="warn-ic">!</span>Tap what it was for first, then press Add';
      warn.classList.add("warn");
      return;
    }
    pendingAmount = amount;
    pendingCategory = category;
    if (isUnusual(amount)) {
      $("did-title").textContent = `Did you mean ${money(amount)}?`;
      $("sheet-did").hidden = false;
      return;
    }
    maybeNudgeOrSave();
  }

  function maybeNudgeOrSave() {
    const info = periodInfo();
    if (!info) return commitSpend();
    const todayAfter = info.todaySpent + pendingAmount;
    const daily = Math.max(info.daily, 0);
    if (daily > 0 && todayAfter >= Math.round(daily * 0.9)) {
      const over = todayAfter > daily;
      $("nudge-tag").textContent = over ? "A little over today" : "Just a heads-up";
      $("nudge-title").textContent = over
        ? `That’s ${money(todayAfter - daily)} over today’s ${money(daily)}.`
        : `This uses most of today’s ${money(daily)}.`;
      $("nudge-plain").textContent = over
        ? "You can still save it. This is just a gentle heads-up, not a stop."
        : "You’ll still have some of today’s amount left. You can save it, or change it.";
      $("sheet-nudge").hidden = false;
      return;
    }
    commitSpend();
  }

  function commitSpend() {
    state.spends.push({
      id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: todayISO(),
      amount: pendingAmount,
      category: pendingCategory,
    });
    save();
    pendingAmount = 0;
    pendingCategory = "";
    closeSheets();
    render();
  }

  // ----- amount inputs -----
  function bindMoneyInput(el, getter, setter) {
    on(el, "focus", () => {
      const cents = getter();
      el.value = cents ? (cents / 100).toString() : "";
    });
    on(el, "input", () => setter(parseDollars(el.value)));
    on(el, "blur", () => {
      const cents = parseDollars(el.value);
      setter(cents);
      el.value = cents ? money(cents) : "";
    });
  }

  function render() {
    if (!state.settings) return renderSetup();
    checkPaydayFlag();
    if (state.pendingPayday) return renderPayday();
    if (!$("view-settings").hidden) return renderSettings();
    return renderToday();
  }

  // ----- events -----
  function bind() {
    // Setup
    bindMoneyInput($("setup-amount"), () => (state._setup && state._setup.amount) || 0, (c) => {
      state._setup.amount = c;
    });
    on($("setup-cycle"), "click", (e) => {
      const b = e.target.closest("button[data-cycle]");
      if (!b) return;
      state._setup.cycle = b.dataset.cycle;
      renderSetup();
    });
    on($("setup-payday"), "click", (e) => {
      const b = e.target.closest("button[data-dow]");
      if (!b) return;
      state._setup.payday = Number(b.dataset.dow);
      renderSetup();
    });
    on($("setup-start"), "click", () => {
      // flush input
      const cents = parseDollars($("setup-amount").value)
        || (state._setup && state._setup.amount) || 0;
      if (cents <= 0) {
        $("setup-amount").focus();
        return;
      }
      const s = state._setup;
      state.settings = { amount: cents, cycle: s.cycle, payday: s.payday };
      startPeriod(todayISO(), cents);
      state.greetOn = null;
      save();
      renderToday();
    });

    // Today
    on($("greet-dismiss"), "click", () => {
      state.greetOn = todayISO();
      save();
      $("greet").hidden = true;
    });
    on($("btn-settings"), "click", () => {
      state._edit = null;
      renderSettings();
    });
    on($("btn-add"), "click", openAdd);
    on($("spend-list"), "click", (e) => {
      const b = e.target.closest(".spend");
      if (!b) return;
      const sp = state.spends.find((s) => s.id === b.dataset.id);
      if (!sp) return;
      deleteId = sp.id;
      $("del-plain").textContent = `${money(sp.amount)} for ${sp.category}, ${formatShortDate(sp.date)}.`;
      $("sheet-delete").hidden = false;
    });

    // Settings
    bindMoneyInput($("set-amount"), () => (state._edit && state._edit.amount) || 0, (c) => {
      state._edit.amount = c;
    });
    on($("set-cycle"), "click", (e) => {
      const b = e.target.closest("button[data-cycle]");
      if (!b) return;
      state._edit.cycle = b.dataset.cycle;
      renderSettings();
    });
    on($("set-payday"), "click", (e) => {
      const b = e.target.closest("button[data-dow]");
      if (!b) return;
      state._edit.payday = Number(b.dataset.dow);
      renderSettings();
    });
    on($("settings-back"), "click", () => {
      state._edit = null;
      renderToday();
    });
    on($("settings-save"), "click", () => {
      const cents = parseDollars($("set-amount").value)
        || (state._edit && state._edit.amount) || 0;
      if (cents <= 0) {
        $("set-amount").focus();
        return;
      }
      const edit = state._edit;
      const paydayChanged = edit.payday !== state.settings.payday || edit.cycle !== state.settings.cycle;
      state.settings = { amount: cents, cycle: edit.cycle, payday: edit.payday };
      if (paydayChanged) {
        // Rebuild the current window from the most recent new payday, keep spends that still fall inside it.
        state.period.start = lastPaydayOnOrBefore(todayISO(), state.settings.payday);
      }
      state.period.total = cents;
      // If the new window has already ended, the payday screen will appear.
      state._edit = null;
      save();
      renderToday();
    });

    // Add sheet
    $("add-keys").innerHTML = ["1","2","3","4","5","6","7","8","9",".","0","DEL"].map((k) => {
      if (k === "DEL") {
        return `<button type="button" class="key ghost" data-key="DEL" aria-label="Delete"><svg width="28" height="20" viewBox="0 0 28 20" fill="none"><path d="M10.2 2.2h15.3A2.5 2.5 0 0 1 28 4.7v10.6a2.5 2.5 0 0 1-2.5 2.5H10.2c-.7 0-1.4-.3-1.9-.8L.8 10.8a1.2 1.2 0 0 1 0-1.6l7.5-6.2c.5-.5 1.2-.8 1.9-.8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M16.2 6.4l6 6.2M22.2 6.4l-6 6.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>`;
      }
      const ghost = k === "." ? " ghost" : "";
      return `<button type="button" class="key${ghost}" data-key="${k}">${k}</button>`;
    }).join("");
    on($("add-keys"), "click", (e) => {
      const b = e.target.closest("[data-key]");
      if (!b) return;
      typeKey(b.dataset.key);
    });
    on($("add-cats"), "click", (e) => {
      const b = e.target.closest("[data-cat]");
      if (!b) return;
      addDraft.category = b.dataset.cat;
      paintAdd();
    });
    on($("add-save"), "click", trySaveSpend);
    on($("sheet-add"), "click", (e) => {
      if (e.target.dataset.close === "add") {
        $("sheet-add").hidden = true;
      }
    });

    on($("did-yes"), "click", () => {
      $("sheet-did").hidden = true;
      maybeNudgeOrSave();
    });
    on($("did-no"), "click", () => {
      $("sheet-did").hidden = true;
    });
    on($("nudge-save"), "click", () => {
      $("sheet-nudge").hidden = true;
      commitSpend();
    });
    on($("nudge-back"), "click", () => {
      $("sheet-nudge").hidden = true;
    });

    on($("del-yes"), "click", () => {
      if (deleteId) {
        state.spends = state.spends.filter((s) => s.id !== deleteId);
        deleteId = null;
        save();
      }
      $("sheet-delete").hidden = true;
      renderToday();
    });
    on($("del-no"), "click", () => {
      deleteId = null;
      $("sheet-delete").hidden = true;
    });
    on($("sheet-delete"), "click", (e) => {
      if (e.target.dataset.close === "delete") {
        deleteId = null;
        $("sheet-delete").hidden = true;
      }
    });

    on($("payday-roll"), "click", () => {
      paydayKeepLeftover = !paydayKeepLeftover;
      renderPayday();
    });
    on($("payday-start"), "click", () => {
      const leftover = leftoverCents();
      const total = paydayKeepLeftover ? state.settings.amount + leftover : state.settings.amount;
      startPeriod(todayISO(), total);
      state.greetOn = null;
      save();
      renderToday();
    });
  }

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  bind();
  checkPaydayFlag();
  render();
  registerSW();

  // Expose a tiny hook for screenshots / checks (no personal data).
  window.BudgetBuddy = {
    todayISO,
    periodInfo,
    isUnusual,
    medianSpend,
    money,
    load: () => state,
  };
})();
