/* NomadMate main screen logic: Ask, trip plans, checklists, history (moved out of index.html in Stage 4 so the page can use a strict Content Security Policy). Loaded last, after the other js/ files. */
  // js/offline.js provides window.OM (connection state, config, service worker). This stub keeps the
  // app working as before if that file ever fails to load.
  const OM = window.OM || {
    apiBase: () => "https://api.outbackmind.au",
    isOnline: () => true,
    configReady: Promise.resolve(),
    reportApiFailure() {},
    reportApiSuccess() {}
  };
  const api = (path) => OM.apiBase() + path;

  function isNetworkError(error) {
    return error instanceof TypeError || (error && error.name === "AbortError");
  }

  const NEEDS_SIGNAL_MSG = "Needs signal. NomadMate could not reach the service. Try again when you have signal.";

  function friendlyError(error) {
    if (isNetworkError(error)) {
      OM.reportApiFailure();
      return NEEDS_SIGNAL_MSG;
    }
    const status = error && error.status;
    if (status === 429) return "Too many requests just now. Please wait a minute and try again.";
    if (status >= 500) return "NomadMate had a problem on its side. Please try again in a moment.";
    // A short message the service chose to show (for example "Please ask a shorter question") is kept.
    if (error && error.serverDetail) return error.serverDetail;
    return "Something went wrong. Please try again in a moment.";
  }

  // Builds an error from a failed API response without ever showing "API returned 500" to a traveller.
  function httpError(response, data) {
    const failure = new Error("http " + response.status);
    failure.status = response.status;
    const d = data && data.detail;
    if (typeof d === "string" && d.length > 0 && d.length <= 200 && !/[{}<>]/.test(d)) failure.serverDetail = d;
    return failure;
  }

  const askBtn = document.getElementById("askBtn");
  const refreshBtn = document.getElementById("refreshBtn");
  const questionEl = document.getElementById("question");
  const outputEl = document.getElementById("output");
  const outputCardEl = document.getElementById("outputCard");
  const outputHeaderEl = document.getElementById("outputHeader");
  const statusEl = document.getElementById("status");
  const historyEl = document.getElementById("history");

  const planBtn = document.getElementById("planBtn");
  const tripInput = document.getElementById("tripInput");
  const tripOutput = document.getElementById("tripOutput");
  const tripStatus = document.getElementById("tripStatus");
  const tripHistory = document.getElementById("tripHistory");
  const refreshPlansBtn = document.getElementById("refreshPlansBtn");

  const checklistBtn = document.getElementById("checklistBtn");
  const copyChecklistBtn = document.getElementById("copyChecklistBtn");
  const checklistInput = document.getElementById("checklistInput");
  const checklistStatus = document.getElementById("checklistStatus");
  const checklistOutput = document.getElementById("checklistOutput");
  let latestChecklist = "";

  // Anonymous per-browser id so each visitor only sees their own history.
  // It is kept in localStorage and mirrored into IndexedDB (js/store.js). If the browser clears localStorage but
  // keeps IndexedDB (or the other way round), the id is restored so the server history stays reachable.
  const CLIENT_KEY = "outbackmind_client_id";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let clientIdWasNew = false;
  let CLIENT_ID = (() => {
    let id = null;
    try { id = localStorage.getItem(CLIENT_KEY); } catch (e) {}
    if (!id || !UUID_RE.test(id)) {
      clientIdWasNew = true;
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
          });
      try { localStorage.setItem(CLIENT_KEY, id); } catch (e) {}
    }
    return id;
  })();
  const Store = window.OMStore || null;
  function adoptClientId(id) {
    CLIENT_ID = id;
    try { localStorage.setItem(CLIENT_KEY, id); } catch (e) {}
    if (Store) Store.setMeta("client_id", id);
  }
  OM.getClientId = () => CLIENT_ID;
  OM.setClientId = (id) => { if (UUID_RE.test(id)) { adoptClientId(id); loadHistory(); loadTripPlans(); } };
  const storeReady = Store
    ? Store.ready.then(async () => {
        const saved = await Store.getMeta("client_id", null);
        if (saved && UUID_RE.test(saved) && saved.toLowerCase() !== CLIENT_ID.toLowerCase()) {
          if (clientIdWasNew) adoptClientId(saved.toLowerCase());   // localStorage was cleared: restore the old id
          else await Store.setMeta("client_id", CLIENT_ID);         // localStorage is the truth: refresh the mirror
        } else if (!saved) {
          await Store.setMeta("client_id", CLIENT_ID);
        }
      }).catch(() => {})
    : Promise.resolve();

  function getSelectedMode() {
    const checked = document.querySelector('input[name="mode"]:checked');
    return checked ? checked.value : "normal";
  }

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  // **bold** from the AI is shown as bold. The text is HTML-escaped first, so the only tags that can
  // appear are the <strong> and <a> added here. A bold span never crosses a line break.
  function inlineMarkup(escaped) {
    return escaped.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "<strong>$1</strong>");
  }

  function formatAnswer(text) {
    const linked = inlineMarkup(escapeHtml(text)).replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:#f59e0b;">$1</a>'
    );

    return linked.replace(/\n/g, "<br>");
  }

  function formatPlan(text) {
    return inlineMarkup(escapeHtml(text)).replace(/\n/g, "<br>");
  }

  function formatChecklist(text) {
    return inlineMarkup(escapeHtml(text)).replace(/\n/g, "<br>");
  }

function renderRecommendedGear(items) {
  if (!items || !items.length) {
    return "";
  }

  // The API returns name, url and category. use_case and priority are shown only when the API sends them,
  // so no empty text or an invented "Recommended" badge appears.
  return `
    <div style="margin-top:18px; padding-top:16px; border-top:1px solid #334155;">
      <div style="font-size:12px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:10px; font-weight:bold;">
        Smart Gear Recommendations
      </div>

      <div style="display:flex; flex-direction:column; gap:8px;">
        ${items.map(item => {
          const name = escapeHtml(item.name || "Recommended gear");
          const url = typeof item.url === "string" && /^https:\/\//i.test(item.url) ? item.url : "";
          const title = url
            ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:#f59e0b; text-decoration:underline;">${name}</a>`
            : name;
          const useCase = item.use_case
            ? `<div style="font-size:12px; color:#cbd5e1; line-height:1.4; margin-top:4px;">${escapeHtml(item.use_case)}</div>`
            : "";
          const badge = item.priority
            ? `<div style="white-space:nowrap; font-size:10px; color:#10b981; border:1px solid rgba(16,185,129,0.4); border-radius:999px; padding:3px 7px; font-weight:700;">${escapeHtml(item.priority)}</div>`
            : "";
          const category = item.category
            ? `<div style="font-size:11px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.06em; margin-top:6px;">${escapeHtml(item.category)}</div>`
            : "";
          return `
          <div style="background:#0b1220; border:1px solid #334155; border-radius:12px; padding:10px 12px;">
            <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
              <div>
                <div style="font-size:14px; font-weight:700; color:#f59e0b;">${title}</div>
                ${useCase}
              </div>
              ${badge}
            </div>
            ${category}
          </div>`;
        }).join("")}
      </div>
    </div>
  `;
}

  // The API sends created_at as an ISO time in UTC without a "Z" (for example 2026-11-18T03:04:05.123456).
  // Without the "Z" a browser reads it as local time and shows the wrong hour, so add it before formatting.
  function formatCreatedAt(value) {
    if (!value) return "";
    const text = String(value);
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
    const parsed = new Date(hasZone ? text : text.replace(/\.(\d{3})\d+/, ".$1") + "Z");
    if (isNaN(parsed.getTime())) return text;
    return parsed.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  }

  // ---- Saved lists: copy kept on this device (js/store.js) ------------------------------------------------
  // Every list is also written to IndexedDB after a successful fetch. Offline, or if the service fails, the saved
  // copy is shown with "Saved copy from <date and time>", and the Refresh buttons say "needs signal".
  const historySavedEl = document.getElementById("historySaved");
  const plansSavedEl = document.getElementById("plansSaved");
  let currentPlans = [];

  function nowIso() { return new Date().toISOString(); }

  function savedNote(el, state, stamp) {
    if (!el) return;
    const persistent = Store && Store.mode() === "indexeddb";
    if (!persistent) {
      el.textContent = "Not saved on this device: this browser is not letting NomadMate keep data (private browsing can do this). Shown for this visit only.";
    } else if (state === "cache") {
      el.textContent = stamp
        ? "Saved copy from " + formatCreatedAt(stamp) + ". Needs signal to refresh."
        : "Saved copy on this device. Needs signal to refresh.";
    } else if (state === "empty") {
      el.textContent = "Nothing is saved on this device yet. Questions and plans you load while online are saved here automatically.";
    } else {
      el.textContent = "Saved on this device. Last updated " + formatCreatedAt(stamp || nowIso()) + ".";
    }
  }

  function renderHistory(items) {
    if (!items.length) {
      historyEl.textContent = "No saved questions yet.";
      return;
    }
    historyEl.innerHTML = items.map(item => `
        <div class="history-item" data-mode="${item.mode === "emergency" ? "emergency" : "normal"}">
          <div class="history-top">
            <div class="history-q">Q: ${escapeHtml(item.question)}</div>
            ${item.mode === "emergency"
              ? '<span class="emergency-badge">EMERGENCY</span>'
              : '<span class="normal-badge">NORMAL</span>'}
          </div>
          <div class="history-a">${formatAnswer(item.answer)}</div>
          <div class="history-time">${escapeHtml(formatCreatedAt(item.created_at))}</div>
        </div>
      `).join("");
    // Long saved answers show the first part with a "Show full answer" button. Emergency answers are always shown in full.
    historyEl.querySelectorAll(".history-item").forEach(item => {
      const a = item.querySelector(".history-a");
      if (window.OMCollapse && a) window.OMCollapse.attach(a, { label: "answer", noClamp: () => item.getAttribute("data-mode") === "emergency" });
    });
    // Only the newest few are listed; "Show all" reveals the rest.
    if (window.OMCollapse) window.OMCollapse.limitList(historyEl, ".history-item", { noun: "saved questions" });
  }

  async function showHistoryFromCache(prefix) {
    const items = Store ? await Store.listHistory() : [];
    if (!items.length) {
      historyEl.textContent = (prefix || "") + "Nothing saved on this device yet. Questions you ask while online are saved here, so you can read them without signal.";
      savedNote(historySavedEl, "empty");
      return false;
    }
    renderHistory(items);
    savedNote(historySavedEl, "cache", Store ? await Store.getMeta("history_synced_at", null) : null);
    return true;
  }

  async function loadHistory() {
    await storeReady;
    if (!OM.isOnline()) {
      await showHistoryFromCache("Needs signal to refresh. ");
      return;
    }
    const hadCache = await showHistoryFromCache("");
    if (!hadCache) historyEl.textContent = "Loading...";
    try {
      const response = await fetch(api("/history"), { headers: { "X-Client-Id": CLIENT_ID } });
      if (!response.ok) {
        throw httpError(response);
      }

      OM.reportApiSuccess();
      const items = await response.json();
      if (Store) {
        await Store.saveHistory(items);
        const all = await Store.listHistory();
        renderHistory(all.length ? all : items);
        if (!all.length) historyEl.textContent = "No saved questions yet.";
        savedNote(historySavedEl, "live", await Store.getMeta("history_synced_at", null));
      } else {
        renderHistory(items);
        savedNote(historySavedEl, "live");
      }
    } catch (error) {
      if (isNetworkError(error)) OM.reportApiFailure();
      const shown = await showHistoryFromCache("");
      if (!shown) {
        historyEl.textContent = isNetworkError(error)
          ? "Needs signal. Saved questions will load when you are back online."
          : "Could not load your saved questions right now. Please try again in a moment.";
      }
    }
  }

  function renderPlans(items) {
    currentPlans = items;
    if (!items.length) {
      tripHistory.textContent = "No saved plans yet.";
      return;
    }
    const online = OM.isOnline();
    tripHistory.innerHTML = items.map((item, idx) => `
      <div class="history-item plan-item">
        <div><strong>${escapeHtml(item.request)}</strong></div>
        <div class="plan-body">${formatPlan(item.plan)}</div>
        <div class="plan-actions">
          <button type="button" class="plan-btn copy-plan-btn" data-idx="${idx}">Copy Plan</button>
          <button type="button" class="plan-btn print-plan-btn" data-idx="${idx}">Print or save as PDF</button>
          ${item.server_id != null && !item.local
            ? `<a class="plan-btn pdf-link" ${online ? "" : "hidden"} href="${api("/trip-plans/" + encodeURIComponent(item.server_id) + "/pdf")}?client_id=${encodeURIComponent(CLIENT_ID)}" target="_blank" rel="noopener noreferrer">Download PDF (needs signal)</a>`
            : ""}
        </div>
        <div class="plan-time">${escapeHtml(formatCreatedAt(item.created_at))}</div>
      </div>
    `).join("");
    tripHistory.querySelectorAll(".plan-body").forEach(b => { if (window.OMCollapse) window.OMCollapse.attach(b, { label: "plan" }); });
    if (window.OMCollapse) window.OMCollapse.limitList(tripHistory, ".plan-item", { noun: "saved plans" });
  }

  tripHistory.addEventListener("click", (e) => {
    const copyBtn = e.target.closest(".copy-plan-btn");
    const printBtn = e.target.closest(".print-plan-btn");
    const btn = copyBtn || printBtn;
    if (!btn) return;
    const item = currentPlans[Number(btn.getAttribute("data-idx"))];
    if (!item) return;
    if (copyBtn) {
      const formatted = `Trip Plan\n\n${item.request}\n\n${item.plan}\n\nGenerated by OutbackMind`;
      navigator.clipboard.writeText(formatted)
        .then(() => { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy Plan"; }, 1500); })
        .catch(() => { btn.textContent = "Could not copy"; setTimeout(() => { btn.textContent = "Copy Plan"; }, 1500); });
    } else if (window.OMPrint) {
      window.OMPrint.print({
        title: "Trip plan",
        lines: [item.request ? "For: " + item.request : "", "Made by the NomadMate AI and not checked against official sources. Saved on this device. " + formatCreatedAt(item.created_at)].filter(Boolean),
        sections: [{ paragraphs: String(item.plan || "").split(/\n+/).filter(Boolean) }],
        footer: ["Guidance only. Check conditions with the land manager. In an emergency, call 000."]
      });
    }
  });

  async function showPlansFromCache(prefix) {
    const items = Store ? await Store.listPlans() : [];
    if (!items.length) {
      tripHistory.textContent = (prefix || "") + "Nothing saved on this device yet. Plans you make or load while online are saved here, so you can read them without signal.";
      savedNote(plansSavedEl, "empty");
      return false;
    }
    renderPlans(items.map(p => ({ id: p.id, server_id: p.server_id, local: p.local, request: p.request, plan: p.plan, created_at: p.created_at })));
    savedNote(plansSavedEl, "cache", await Store.getMeta("plans_synced_at", null));
    return true;
  }

  async function loadTripPlans() {
    await storeReady;
    if (!OM.isOnline()) {
      await showPlansFromCache("Needs signal to refresh. ");
      return;
    }
    const hadCache = await showPlansFromCache("");
    if (!hadCache) tripHistory.textContent = "Loading...";
    try {
      const response = await fetch(api("/trip-plans"), { headers: { "X-Client-Id": CLIENT_ID } });
      if (!response.ok) {
        throw httpError(response);
      }

      OM.reportApiSuccess();
      const items = await response.json();
      if (Store) {
        await Store.savePlans(items);
        const all = await Store.listPlans();
        if (all.length) renderPlans(all.map(p => ({ id: p.id, server_id: p.server_id, local: p.local, request: p.request, plan: p.plan, created_at: p.created_at })));
        else tripHistory.textContent = "No saved plans yet.";
        savedNote(plansSavedEl, "live", await Store.getMeta("plans_synced_at", null));
      } else {
        renderPlans(items.map(p => ({ id: p.id, server_id: p.id, request: p.request, plan: p.plan, created_at: p.created_at })));
        savedNote(plansSavedEl, "live");
      }
    } catch (error) {
      if (isNetworkError(error)) OM.reportApiFailure();
      const shown = await showPlansFromCache("");
      if (!shown) {
        tripHistory.textContent = isNetworkError(error)
          ? "Needs signal. Saved plans will load when you are back online."
          : "Could not load your saved plans right now. Please try again in a moment.";
      }
    }
  }

  // Refresh buttons need signal; the saved lists do not.
  function updateRefreshButtons() {
    const online = OM.isOnline();
    if (refreshBtn) { refreshBtn.disabled = !online; refreshBtn.textContent = online ? "Refresh History" : "Refresh needs signal"; }
    if (refreshPlansBtn) { refreshPlansBtn.disabled = !online; refreshPlansBtn.textContent = online ? "Refresh Plans" : "Refresh needs signal"; }
    tripHistory.querySelectorAll(".pdf-link").forEach(a => { a.hidden = !online; });
  }

  if (checklistBtn) {
    checklistBtn.addEventListener("click", async () => {
      const request = checklistInput.value.trim();

      if (!request) {
        checklistStatus.textContent = "Please describe the trip first.";
        return;
      }
      if (!OM.isOnline()) {
        checklistStatus.textContent = "Needs signal. The checklist generator needs an internet connection.";
        return;
      }

      checklistBtn.disabled = true;
      copyChecklistBtn.disabled = true;
      checklistStatus.textContent = "Generating your checklist...";
      checklistOutput.innerHTML = "";

      try {
        const response = await fetch(api("/generate-checklist"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Client-Id": CLIENT_ID
          },
          body: JSON.stringify({ request })
        });

        const data = await response.json();

        if (!response.ok) {
          throw httpError(response, data);
        }

        OM.reportApiSuccess();
        latestChecklist = data.checklist || "";
        copyChecklistBtn.disabled = !latestChecklist;
        // The server does not keep generated checklists, so save this one on this device.
        let rec = null;
        if (Store && latestChecklist) rec = await Store.saveChecklist({ request, text: latestChecklist });
        if (rec && window.OMChecklists) {
          checklistOutput.textContent = "";
          checklistOutput.appendChild(window.OMChecklists.renderRecord(rec, { noCopy: true }));
        } else {
          checklistOutput.innerHTML = formatChecklist(latestChecklist);
        }
        checklistStatus.textContent = rec
          ? (Store.mode() === "indexeddb" ? "Checklist generated and saved on this device. Tick items as you go. " : "Checklist generated. Not saved: this browser is not letting NomadMate keep data. ")
          : "Checklist generated.";
        if (rec && Store.mode() === "indexeddb") {
          const a = document.createElement("a");
          a.href = "#checklists/a/" + encodeURIComponent(rec.id);
          a.textContent = "Open it in Checklists";
          checklistStatus.appendChild(a);
        }
      } catch (error) {
        checklistStatus.textContent = friendlyError(error);
      } finally {
        checklistBtn.disabled = false;
      }
    });
  }

  if (copyChecklistBtn) {
    copyChecklistBtn.addEventListener("click", async () => {
      if (!latestChecklist) {
        return;
      }

      try {
        await navigator.clipboard.writeText(
          `OutbackMind Trip Checklist\n\n${latestChecklist}\n\nGenerated by OutbackMind`
        );
        copyChecklistBtn.textContent = "Copied!";
        setTimeout(() => {
          copyChecklistBtn.textContent = "Copy Checklist";
        }, 1500);
      } catch (error) {
        checklistStatus.textContent = "Could not copy the checklist.";
      }
    });
  }

  // ---- Ask: offline guide match (not an AI answer) -------------------------------------------------
  // Answer box: compact by default, with Copy and New question at the top. Emergency answers are never cut short.
  const PLACEHOLDER_TEXT = "Your answer will appear here.";
  const ERROR_TEXT = "Something went wrong while contacting OutbackMind.";
  const outputToolsEl = document.getElementById("outputTools");
  const copyAnswerBtn = document.getElementById("copyAnswerBtn");
  const newQuestionBtn = document.getElementById("newQuestionBtn");
  if (window.OMCollapse) {
    window.OMCollapse.attach(outputEl, { label: "answer", observe: true, noClamp: () => outputCardEl.classList.contains("emergency") });
    window.OMCollapse.attach(tripOutput, { label: "plan", observe: true });
  }
  function updateOutputTools() {
    const t = (outputEl.textContent || "").trim();
    outputToolsEl.hidden = !t || t === PLACEHOLDER_TEXT || t === ERROR_TEXT;
    // On the Ask screen the answer arrives below the question box. If it is below the fold, bring it into view.
    if (!outputToolsEl.hidden && outputCardEl.clientWidth && outputCardEl.getBoundingClientRect().top > window.innerHeight * 0.55) {
      outputCardEl.scrollIntoView({ block: "start" });
    }
  }
  new MutationObserver(updateOutputTools).observe(outputEl, { childList: true, subtree: true, characterData: true });
  copyAnswerBtn.addEventListener("click", () => {
    const txt = (outputEl.innerText || outputEl.textContent || "").trim();
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
      .then(() => { copyAnswerBtn.textContent = "Copied"; })
      .catch(() => { copyAnswerBtn.textContent = "Could not copy"; })
      .finally(() => setTimeout(() => { copyAnswerBtn.textContent = "Copy"; }, 1500));
  });
  newQuestionBtn.addEventListener("click", () => {
    questionEl.value = "";
    outputCardEl.classList.remove("emergency");
    outputHeaderEl.textContent = "Latest Answer";
    outputEl.textContent = PLACEHOLDER_TEXT;
    statusEl.textContent = "";
    const ask = document.getElementById("askCard");
    if (ask) ask.scrollIntoView({ block: "start" });
    questionEl.focus({ preventScroll: true });
  });

  // When the phone is offline, or the service fails, Normal Mode searches the guides saved on the phone.
  // Emergency Mode is never queued and never depends on the AI: offline it opens the Emergency screen.
  const askOfflineNote = document.getElementById("askOfflineNote");
  const ASK_LABEL = "Ask OutbackMind";

  function isServiceFailure(error) {
    return isNetworkError(error) || !!(error && (error.status >= 500 || error.name === "SyntaxError"));
  }

  function updateAskForConnection() {
    const offline = !OM.isOnline();
    if (askOfflineNote) askOfflineNote.hidden = !offline;
    askBtn.textContent = !offline ? ASK_LABEL : (getSelectedMode() === "emergency" ? "Open Emergency screen" : "Search saved guides");
    updateQueueButton();
  }

  // Stage 4: saving a question to send later. Normal Mode only, never Emergency, and only by pressing the button.
  const queueBtn = document.getElementById("queueBtn");
  let askFailedOnline = false;
  function updateQueueButton() {
    if (!queueBtn) return;
    const Q = window.OMQueue;
    const show = !!(Q && Q.enabled() && getSelectedMode() === "normal" && (!OM.isOnline() || askFailedOnline));
    queueBtn.hidden = !show;
  }

  async function showOfflineGuideMatch(question, reason, emergencyLink) {
    outputCardEl.classList.remove("emergency");
    outputHeaderEl.textContent = (window.OMGuides && window.OMGuides.label) || "Offline guide match, not an AI answer";
    statusEl.textContent = reason;
    outputEl.textContent = "";
    if (emergencyLink) {
      const p = document.createElement("p");
      p.appendChild(document.createTextNode("If someone needs help now, "));
      const a = document.createElement("a");
      a.href = "#emergency";
      a.style.color = "#fbbf24";
      a.textContent = "open the offline Emergency screen";
      p.appendChild(a);
      p.appendChild(document.createTextNode("."));
      outputEl.appendChild(p);
    }
    const holder = document.createElement("div");
    outputEl.appendChild(holder);
    if (window.OMGuides) {
      await window.OMGuides.renderAskMatch(holder, question);
    } else {
      holder.textContent = "The saved guides are not available. Open the Emergency screen if someone needs help now.";
    }
  }

  if (queueBtn) {
    queueBtn.addEventListener("click", async () => {
      const Q = window.OMQueue;
      const question = questionEl.value.trim();
      if (!Q || getSelectedMode() !== "normal") return;   // Emergency Mode is never saved for later
      const res = Q.add({ question, mode: "normal" });
      if (!res.ok) {
        statusEl.textContent = res.reason === "duplicate" ? "That question is already saved. NomadMate will send it once, when you are back online." : res.message;
        return;
      }
      await showOfflineGuideMatch(question, OM.isOnline()
        ? "Saved. NomadMate is sending your question now. These saved guides are not the answer."
        : "Saved on this phone. NomadMate will send it when you are back online. These saved guides are not the answer.", true);
      questionEl.value = "";
      askFailedOnline = false;
      updateQueueButton();
      if (window.OMQueueUI) window.OMQueueUI.announce("Question saved. It will be sent when you are back online.");
      if (OM.isOnline()) Q.flush();
    });
  }
  if (window.OMQueueUI) window.OMQueueUI.setAnswerRenderer((it) => formatAnswer(it.answer || "") + renderRecommendedGear(it.gear || []));
  // A saved question was answered while the app was open: keep the answer in Recent questions like any other.
  document.addEventListener("om:queue-answered", async (e) => {
    const it = e.detail && e.detail.item;
    if (it && it.answer && Store) { try { await Store.addLocalHistory({ question: it.question, mode: "normal", answer: it.answer, created_at: it.answered_at || nowIso() }); } catch (err) {} }
    loadHistory();
  });
  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", updateAskForConnection));
  document.addEventListener("om:connectivity", (e) => { if (e.detail && e.detail.online && e.detail.changed) askFailedOnline = false; updateAskForConnection(); });
  updateAskForConnection();

  askBtn.addEventListener("click", async () => {
    const question = questionEl.value.trim();
    const mode = getSelectedMode();

    if (!OM.isOnline()) {
      // Emergency questions are never queued or answered later: send people to the offline Emergency screen.
      if (mode === "emergency") {
        location.hash = "#emergency";
        return;
      }
      if (!question) {
        statusEl.textContent = "Please enter a question.";
        return;
      }
      await showOfflineGuideMatch(question, "Offline: showing saved guides on this phone. Your question was not sent or saved.", false);
      return;
    }

    if (!question) {
      statusEl.textContent = "Please enter a question.";
      return;
    }

    askBtn.disabled = true;
    statusEl.textContent = mode === "emergency"
      ? "Generating emergency guidance..."
      : "Thinking...";

    outputEl.textContent = "";
    outputCardEl.classList.toggle("emergency", mode === "emergency");
    outputHeaderEl.textContent = mode === "emergency"
      ? "Emergency Response"
      : "Latest Answer";

    try {
      const response = await fetch(api("/ask"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Client-Id": CLIENT_ID
        },
        body: JSON.stringify({ question, mode })
      });

      const data = await response.json();

      if (!response.ok) {
        throw httpError(response, data);
      }

      OM.reportApiSuccess();
      outputEl.innerHTML =
        formatAnswer(data.answer || "") +
        renderRecommendedGear(data.recommended_gear || []);

      statusEl.textContent = mode === "emergency"
        ? "Emergency response received and saved."
        : "Response received and saved.";

      questionEl.value = "";
      askFailedOnline = false; updateQueueButton();
      if (Store && data.answer) await Store.addLocalHistory({ question, mode, answer: data.answer, created_at: nowIso() });
      await loadHistory();
    } catch (error) {
      if (isServiceFailure(error)) {
        // Network error or server failure: fall back to the saved guides. Never queued, never retried later.
        if (isNetworkError(error)) OM.reportApiFailure();
        const canSave = !!(window.OMQueue && window.OMQueue.enabled() && mode === "normal" && isNetworkError(error));
        if (canSave) { askFailedOnline = true; updateQueueButton(); }
        await showOfflineGuideMatch(question, "Needs signal. NomadMate could not reach the AI service. Showing saved guides on this phone instead. " + (canSave ? "Your question was not saved. Choose Save to send when online if you want NomadMate to send it later." : "Your question was not saved."), true);
      } else {
        statusEl.textContent = friendlyError(error);
        outputEl.textContent = ERROR_TEXT;
      }
    } finally {
      askBtn.disabled = false;
    }
  });

  if (planBtn) {
    planBtn.addEventListener("click", async () => {
      const request = tripInput.value.trim();

      if (!request) {
        tripStatus.textContent = "Please enter a trip request.";
        return;
      }
      if (!OM.isOnline()) {
        tripStatus.textContent = "Needs signal. Trip planning needs an internet connection.";
        return;
      }

      tripStatus.textContent = "Planning your trip...";
      tripOutput.innerHTML = "";
      planBtn.disabled = true;

      try {
        const response = await fetch(api("/plan-trip"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Client-Id": CLIENT_ID
          },
          body: JSON.stringify({ request })
        });

        const data = await response.json();

        if (!response.ok) {
          throw httpError(response, data);
        }

        OM.reportApiSuccess();
        tripOutput.innerHTML = formatPlan(data.plan || "");
        tripStatus.textContent = "Trip plan generated and saved.";
        tripInput.value = "";
        if (Store && data.plan) await Store.addLocalPlan({ request, plan: data.plan });
        await loadTripPlans();
      } catch (error) {
        tripStatus.textContent = friendlyError(error);
      } finally {
        planBtn.disabled = false;
      }
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", loadHistory);
  }

  if (refreshPlansBtn) {
    refreshPlansBtn.addEventListener("click", loadTripPlans);
  }

  // Wait for config (API address) and for on-device storage before the first calls. Neither promise rejects.
  Promise.all([OM.configReady, storeReady]).then(() => {
    loadHistory();
    loadTripPlans();
    updateRefreshButtons();
  });
  updateRefreshButtons();

  // Refresh saved lists when the connection comes back, and keep the Refresh buttons honest.
  document.addEventListener("om:connectivity", (e) => {
    updateRefreshButtons();
    if (e.detail && e.detail.online && e.detail.changed) {
      loadHistory();
      loadTripPlans();
    }
  });
  // After a restore or "Clear saved data" on the settings screen, redraw the lists from the device copy.
  document.addEventListener("om:local-data-changed", () => { loadHistory(); loadTripPlans(); });

  // iPhone and iPad (Safari, not the Home Screen app): saved data can be deleted if the app is not opened.
  if (window.OMSettings && window.OMSettings.isIos() && !window.OMSettings.isStandalone()) {
    window.OMSettings.iosNote().then((box) => { const h = document.getElementById("iosNoteHome"); if (box && h) h.appendChild(box); }).catch(() => {});
  }
