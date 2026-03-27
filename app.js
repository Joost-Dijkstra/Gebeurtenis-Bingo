const STORAGE_KEYS = {
  config: "party-bingo-config",
  session: "party-bingo-session",
  lastName: "party-bingo-last-name",
};

const REFRESH_DELAY_MS = 180;
const TOAST_LIFETIME_MS = 3200;

const appElement = document.querySelector("#app");
const toastElement = document.querySelector("#toast-stack");

const state = {
  config: loadJson(STORAGE_KEYS.config) ?? { url: "", anonKey: "", publicAppUrl: "" },
  session: loadJson(STORAGE_KEYS.session),
  lastName: localStorage.getItem(STORAGE_KEYS.lastName) ?? "",
  prefillCode: readCodeFromUrl(),
  supabase: null,
  game: null,
  players: [],
  events: [],
  cardEntries: [],
  awards: [],
  channel: null,
  refreshTimer: null,
  finishTimer: null,
  recentHitTimer: null,
  isHydrating: false,
  isMutating: false,
  draftSelectionIds: [],
  draftDirty: false,
  mergeSourceEventId: null,
  recentEntryIds: [],
  justFinished: false,
  drag: {
    active: false,
    pointerId: null,
    sourceIndex: -1,
    overIndex: -1,
    ghostText: "",
    ghostX: 0,
    ghostY: 0,
  },
  toasts: [],
};

document.addEventListener("submit", handleSubmit);
document.addEventListener("click", handleClick);
document.addEventListener("pointerdown", handleDraftPointerDown);
document.addEventListener("pointermove", handleDraftPointerMove);
document.addEventListener("pointerup", handleDraftPointerUp);
document.addEventListener("pointercancel", handleDraftPointerUp);

boot();

async function boot() {
  render();

  if (!window.supabase?.createClient) {
    pushToast("Supabase kon niet geladen worden.", "error");
    return;
  }

  if (!isConfigured()) {
    return;
  }

  connectSupabase();

  if (state.session?.gameId) {
    await restoreSession();
  }

  render();
}

function loadJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function isConfigured() {
  return Boolean(state.config.url && state.config.anonKey);
}

function readCodeFromUrl() {
  const url = new URL(window.location.href);
  return (url.searchParams.get("code") ?? "").trim().toUpperCase();
}

function writeCodeToUrl(code) {
  const url = new URL(window.location.href);
  state.prefillCode = code || "";

  if (code) {
    url.searchParams.set("code", code);
  } else {
    url.searchParams.delete("code");
  }

  window.history.replaceState({}, "", url);
}

function connectSupabase() {
  const { createClient } = window.supabase;

  state.supabase = createClient(state.config.url, state.config.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  });
}

async function restoreSession() {
  state.isHydrating = true;
  render();

  try {
    await loadSnapshot();
    setupRealtime();
  } catch (error) {
    clearSession({ keepUrlCode: true });
    pushToast(normalizeError(error, "Kon de vorige sessie niet herstellen."), "error");
  } finally {
    state.isHydrating = false;
    render();
  }
}

async function loadSnapshot() {
  if (!state.supabase || !state.session?.gameId) {
    return;
  }

  const previousStatus = state.game?.status;
  const hadLoadedGame = Boolean(state.game);
  const previousCheckedIds = new Set(
    getMyCardEntries().filter((entry) => entry.checked).map((entry) => entry.id)
  );
  const previousAwardIds = new Set((state.awards || []).map((award) => award.id));

  const gameId = state.session.gameId;

  const [gameResult, playersResult, eventsResult, entriesResult, awardsResult] = await Promise.all([
    state.supabase.from("games").select("*").eq("id", gameId).single(),
    state.supabase.from("players").select("*").eq("game_id", gameId).order("joined_at", { ascending: true }),
    state.supabase.from("events").select("*").eq("game_id", gameId).order("created_at", { ascending: true }),
    state.supabase
      .from("player_card_entries")
      .select("*")
      .eq("game_id", gameId)
      .order("position_index", { ascending: true }),
    state.supabase
      .from("player_awards")
      .select("*")
      .eq("game_id", gameId)
      .order("achievement_type", { ascending: true })
      .order("placement", { ascending: true }),
  ]);

  if (gameResult.error) {
    throw gameResult.error;
  }

  if (playersResult.error) {
    throw playersResult.error;
  }

  if (eventsResult.error) {
    throw eventsResult.error;
  }

  if (entriesResult.error) {
    throw entriesResult.error;
  }

  if (awardsResult.error) {
    throw awardsResult.error;
  }

  state.game = gameResult.data;
  state.players = playersResult.data ?? [];
  state.events = eventsResult.data ?? [];
  state.cardEntries = entriesResult.data ?? [];
  state.awards = awardsResult.data ?? [];

  if (!state.players.some((player) => player.id === state.session.playerId)) {
    throw new Error("Deze speler bestaat niet meer in dit spel.");
  }

  state.session.gameCode = state.game.code;
  saveJson(STORAGE_KEYS.session, state.session);
  writeCodeToUrl(state.game.code);

  syncDraftSelection();
  syncRecentChecks(previousCheckedIds);
  syncAwardUpdates(previousAwardIds, hadLoadedGame);
  syncFinishAnimation(previousStatus);
  render();
}

function syncDraftSelection() {
  const activeEventIds = new Set(getActiveEvents().map((event) => event.id));
  state.draftSelectionIds = state.draftSelectionIds.filter((eventId) => activeEventIds.has(eventId));

  if (state.game?.status !== "building_cards") {
    state.draftSelectionIds = getMyCardEntries().map((entry) => entry.event_id);
    state.draftDirty = false;
    state.mergeSourceEventId = null;
    resetDraftDrag(false);
    return;
  }

  if (!state.draftDirty) {
    state.draftSelectionIds = getMyCardEntries().map((entry) => entry.event_id);
  }
}

function syncRecentChecks(previousCheckedIds) {
  const currentCheckedIds = getMyCardEntries()
    .filter((entry) => entry.checked)
    .map((entry) => entry.id);

  const nextRecentIds = currentCheckedIds.filter((entryId) => !previousCheckedIds.has(entryId));
  state.recentEntryIds = nextRecentIds;

  if (nextRecentIds.length) {
    window.clearTimeout(state.recentHitTimer);
    state.recentHitTimer = window.setTimeout(() => {
      state.recentEntryIds = [];
      render();
    }, 1300);
  }
}

function syncFinishAnimation(previousStatus) {
  const finishedNow = previousStatus !== "finished" && state.game?.status === "finished";
  state.justFinished = finishedNow;

  if (finishedNow) {
    pushToast("Bingo! Het spel is afgelopen.", "success");
    window.clearTimeout(state.finishTimer);
    state.finishTimer = window.setTimeout(() => {
      state.justFinished = false;
      render();
    }, 3600);
  }
}

function setupRealtime() {
  if (!state.supabase || !state.session?.gameId) {
    return;
  }

  teardownRealtime();

  const gameId = state.session.gameId;
  const channel = state.supabase.channel(`party-bingo:${gameId}`);
  const refresh = () => scheduleRefresh();

  channel
    .on("postgres_changes", { event: "*", schema: "public", table: "games", filter: `id=eq.${gameId}` }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `game_id=eq.${gameId}` }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "events", filter: `game_id=eq.${gameId}` }, refresh)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "player_card_entries", filter: `game_id=eq.${gameId}` },
      refresh
    )
    .on("postgres_changes", { event: "*", schema: "public", table: "player_awards", filter: `game_id=eq.${gameId}` }, refresh)
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR") {
        pushToast("Realtime verbinding hapert. Ververs desnoods even.", "error");
      }
    });

  state.channel = channel;
}

function teardownRealtime() {
  if (state.channel && state.supabase) {
    state.supabase.removeChannel(state.channel);
  }

  state.channel = null;
}

function scheduleRefresh() {
  if (state.refreshTimer) {
    return;
  }

  state.refreshTimer = window.setTimeout(async () => {
    state.refreshTimer = null;

    try {
      await loadSnapshot();
    } catch (error) {
      pushToast(normalizeError(error, "Kon de speldata niet verversen."), "error");
    }
  }, REFRESH_DELAY_MS);
}

function clearSession({ keepUrlCode = false } = {}) {
  teardownRealtime();
  window.clearTimeout(state.refreshTimer);
  window.clearTimeout(state.finishTimer);
  window.clearTimeout(state.recentHitTimer);

  state.session = null;
  state.game = null;
  state.players = [];
  state.events = [];
  state.cardEntries = [];
  state.awards = [];
  state.refreshTimer = null;
  state.draftSelectionIds = [];
  state.draftDirty = false;
  state.mergeSourceEventId = null;
  state.recentEntryIds = [];
  state.justFinished = false;
  resetDraftDrag(false);
  state.isHydrating = false;
  state.isMutating = false;

  localStorage.removeItem(STORAGE_KEYS.session);

  if (!keepUrlCode) {
    writeCodeToUrl("");
  }
}

function persistSession(sessionRow) {
  state.session = {
    gameId: sessionRow.game_id,
    gameCode: sessionRow.code,
    playerId: sessionRow.player_id,
    playerName: sessionRow.player_name,
    sessionToken: sessionRow.session_token,
  };

  saveJson(STORAGE_KEYS.session, state.session);
  localStorage.setItem(STORAGE_KEYS.lastName, state.session.playerName);
  state.lastName = state.session.playerName;
  writeCodeToUrl(sessionRow.code);
}

function getRequiredCount() {
  return state.game?.board_size ? state.game.board_size * state.game.board_size : 0;
}

function getActiveEvents() {
  return [...state.events]
    .filter((event) => !event.merged_into_event_id)
    .sort((left, right) => {
      if (left.triggered === right.triggered) {
        return new Date(left.created_at) - new Date(right.created_at);
      }
      return left.triggered ? 1 : -1;
    });
}

function getMyCardEntries() {
  if (!state.session?.playerId) {
    return [];
  }

  return [...state.cardEntries]
    .filter((entry) => entry.player_id === state.session.playerId)
    .sort((left, right) => left.position_index - right.position_index);
}

function getPlayerName(playerId) {
  return state.players.find((player) => player.id === playerId)?.name ?? "Onbekende speler";
}

function getPlayerAward(playerId, achievementType) {
  return state.awards.find(
    (award) => award.player_id === playerId && award.achievement_type === achievementType
  );
}

function getAwardsByType(achievementType) {
  return state.awards
    .filter((award) => award.achievement_type === achievementType)
    .sort((left, right) => left.placement - right.placement);
}

function getScoreRows() {
  const requiredCount = getRequiredCount();

  return state.players
    .map((player) => {
      const entries = state.cardEntries.filter((entry) => entry.player_id === player.id);
      const checkedCount = entries.filter((entry) => entry.checked).length;

      return {
        player,
        entries,
        checkedCount,
        selectedCount: entries.length,
        ready: requiredCount > 0 && entries.length === requiredCount,
        lineAward: getPlayerAward(player.id, "line"),
        fullCardAward: getPlayerAward(player.id, "full_card"),
      };
    })
    .sort((left, right) => {
      if (Boolean(left.fullCardAward) !== Boolean(right.fullCardAward)) {
        return left.fullCardAward ? -1 : 1;
      }

      if (left.fullCardAward && right.fullCardAward && left.fullCardAward.placement !== right.fullCardAward.placement) {
        return left.fullCardAward.placement - right.fullCardAward.placement;
      }

      if (Boolean(left.lineAward) !== Boolean(right.lineAward)) {
        return left.lineAward ? -1 : 1;
      }

      if (left.lineAward && right.lineAward && left.lineAward.placement !== right.lineAward.placement) {
        return left.lineAward.placement - right.lineAward.placement;
      }

      if (state.game?.status === "building_cards") {
        if (left.ready !== right.ready) {
          return left.ready ? -1 : 1;
        }
        return left.player.name.localeCompare(right.player.name, "nl");
      }

      if (left.checkedCount !== right.checkedCount) {
        return right.checkedCount - left.checkedCount;
      }

      return left.player.name.localeCompare(right.player.name, "nl");
    });
}

function isHost() {
  return Boolean(state.session?.playerId && state.game?.host_player_id === state.session.playerId);
}

function canHostEditEvents() {
  return isHost() && ["collecting_events", "choosing_board_size", "building_cards"].includes(state.game?.status);
}

function allPlayersReady() {
  const requiredCount = getRequiredCount();
  if (!requiredCount) {
    return false;
  }

  return getScoreRows().every((row) => row.selectedCount === requiredCount);
}

function getStatusMeta() {
  switch (state.game?.status) {
    case "collecting_events":
      return {
        title: "Gebeurtenissen verzamelen",
        copy: "Iedereen kan nu gebeurtenissen toevoegen. Exacte dubbels worden direct geblokkeerd.",
      };
    case "choosing_board_size":
      return {
        title: "Formaat kiezen",
        copy: "De lijst staat vast. De host kiest nu of het spel op een 3x3 of 4x4 kaart gespeeld wordt.",
      };
    case "building_cards":
      return {
        title: "Kaarten samenstellen",
        copy: "Iedere speler kiest exact zijn eigen gebeurtenissen. Vakjes worden later alleen automatisch afgevinkt.",
      };
    case "playing":
      return {
        title: "Spel bezig",
        copy: "Iedereen ziet dezelfde gebeurtenissenlijst. Er zijn nu twee ranglijsten: eerste volledige rij en volledige kaart.",
      };
    case "finished":
      return {
        title: "Bingo gevallen",
        copy: "Het spel is afgerond. De eindstand hieronder laat zien wie een complete kaart had.",
      };
    default:
      return {
        title: "Party Bingo",
        copy: "Maak een spel aan of join via de code van de host.",
      };
  }
}

function getPhaseChips() {
  const order = ["collecting_events", "choosing_board_size", "building_cards", "playing"];
  const steps = [
    ["collecting_events", "1. Lijst vullen"],
    ["choosing_board_size", "2. Formaat kiezen"],
    ["building_cards", "3. Kaarten maken"],
    ["playing", "4. Spelen"],
  ];

  const currentIndex = order.indexOf(state.game?.status);

  return steps
    .map(([stepKey, label]) => {
      const stepIndex = order.indexOf(stepKey);
      const isActive = currentIndex === stepIndex;
      const isPast = stepIndex < currentIndex;
      const chipClass = isActive ? "chip chip-accent" : isPast ? "chip chip-success" : "chip chip-muted";
      return `<span class="${chipClass}">${label}</span>`;
    })
    .join("");
}

function syncAwardUpdates(previousAwardIds, hadLoadedGame) {
  if (!hadLoadedGame) {
    return;
  }

  const freshAwards = state.awards.filter((award) => !previousAwardIds.has(award.id));

  freshAwards.forEach((award) => {
    const playerName = getPlayerName(award.player_id);
    const awardLabel = award.achievement_type === "line" ? "eerste rij" : "volle kaart";
    const toastType = award.player_id === state.session?.playerId ? "success" : "info";
    pushToast(`${playerName} pakte ${awardLabel} plek #${award.placement}.`, toastType);
  });
}

function getShareUrl() {
  const code = state.game?.code || state.session?.gameCode || "";
  const baseUrl = state.config.publicAppUrl?.trim() || window.location.href;
  const url = new URL(baseUrl);

  if (code) {
    url.searchParams.set("code", code);
  }

  return url.toString();
}

function isLocalFileMode() {
  return window.location.protocol === "file:" && !state.config.publicAppUrl?.trim();
}

function makeId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function pushToast(message, type = "info") {
  const toast = {
    id: makeId(),
    message,
    type,
  };

  state.toasts = [...state.toasts.slice(-3), toast];
  renderToasts();

  window.setTimeout(() => {
    state.toasts = state.toasts.filter((item) => item.id !== toast.id);
    renderToasts();
  }, TOAST_LIFETIME_MS);
}

function renderToasts() {
  toastElement.innerHTML = state.toasts
    .map((toast) => `<div class="toast toast-${toast.type}">${escapeHtml(toast.message)}</div>`)
    .join("");
}

function render() {
  if (!state.session) {
    appElement.innerHTML = renderLobby();
    renderToasts();
    return;
  }

  if (state.isHydrating && !state.game) {
    appElement.innerHTML = renderLoadingState();
    renderToasts();
    return;
  }

  if (!state.game) {
    appElement.innerHTML = renderLobby();
    renderToasts();
    return;
  }

  appElement.innerHTML = renderGameView();
  renderToasts();
}

function renderLoadingState() {
  return `
    <section class="panel panel-pad stack">
      <p class="eyebrow">Party Bingo</p>
      <h2>Spel wordt geladen...</h2>
      <p class="subtitle">We halen de laatste stand van de lobby, gebeurtenissen en kaarten op.</p>
    </section>
  `;
}

function renderLobby() {
  const configReady = isConfigured();
  const buttonDisabled = configReady ? "" : "disabled";

  return `
    <section class="panel panel-pad stack">
      <div class="title-row">
        <div>
          <p class="eyebrow">1. Supabase koppelen</p>
          <h2>Eenmalige projectinstellingen</h2>
          <p class="subtitle">
            Plak je Supabase project-URL en anon key hier. Draai eerst <code>supabase.sql</code> in de SQL editor.
          </p>
        </div>
        <span class="${configReady ? "chip chip-success" : "chip chip-muted"}">
          ${configReady ? "Klaar om te spelen" : "Nog niet gekoppeld"}
        </span>
      </div>

      <form data-form="save-config" class="grid-cards">
        <label class="input-group">
          <span class="input-label">Supabase project URL</span>
          <input
            class="text-input"
            type="url"
            name="url"
            placeholder="https://jouw-project.supabase.co"
            value="${escapeHtml(state.config.url)}"
            required
          >
        </label>

        <label class="input-group">
          <span class="input-label">Supabase anon key</span>
          <input
            class="text-input"
            type="text"
            name="anonKey"
            placeholder="eyJ..."
            value="${escapeHtml(state.config.anonKey)}"
            required
          >
        </label>

        <label class="input-group">
          <span class="input-label">Publieke app URL (optioneel)</span>
          <input
            class="text-input"
            type="url"
            name="publicAppUrl"
            placeholder="https://jouw-app.netlify.app"
            value="${escapeHtml(state.config.publicAppUrl || "")}"
          >
        </label>

        <div class="button-row">
          <button class="btn btn-primary" type="submit">Opslaan</button>
          <p class="helper tiny">Instellingen blijven lokaal in deze browser staan.</p>
        </div>
      </form>
    </section>

    <section class="split">
      <article class="panel panel-pad stack">
        <div>
          <p class="eyebrow">2. Spel starten</p>
          <h2>Nieuwe lobby maken</h2>
          <p class="subtitle">De host krijgt alleen de minimale extra rechten die nodig zijn voor de flow.</p>
        </div>

        <form data-form="create-game" class="stack">
          <label class="input-group">
            <span class="input-label">Jouw naam</span>
            <input
              class="text-input"
              type="text"
              name="name"
              maxlength="24"
              placeholder="Bijvoorbeeld Sam"
              value="${escapeHtml(state.lastName)}"
              required
            >
          </label>

          <button class="btn btn-primary" type="submit" ${buttonDisabled}>Maak lobby</button>
        </form>
      </article>

      <article class="panel panel-pad stack">
        <div>
          <p class="eyebrow">3. Meespelen</p>
          <h2>Join via code</h2>
          <p class="subtitle">Gebruik de spelcode van de host of open direct de gedeelde link.</p>
        </div>

        <form data-form="join-game" class="stack">
          <label class="input-group">
            <span class="input-label">Jouw naam</span>
            <input
              class="text-input"
              type="text"
              name="name"
              maxlength="24"
              placeholder="Bijvoorbeeld Noor"
              value="${escapeHtml(state.lastName)}"
              required
            >
          </label>

          <label class="input-group">
            <span class="input-label">Spelcode</span>
            <input
              class="text-input"
              type="text"
              name="code"
              maxlength="6"
              placeholder="ABCDE"
              value="${escapeHtml(state.prefillCode)}"
              required
            >
          </label>

          <button class="btn btn-secondary" type="submit" ${buttonDisabled}>Join spel</button>
        </form>
      </article>
    </section>
  `;
}

function renderGameView() {
  const statusMeta = getStatusMeta();
  const requiredCount = getRequiredCount();
  const scoreRows = getScoreRows();
  const activeEvents = getActiveEvents();
  const triggeredCount = activeEvents.filter((event) => event.triggered).length;

  return `
    <section class="panel panel-pad status-banner">
      <div class="title-row">
        <div>
          <p class="eyebrow">Spelcode ${escapeHtml(state.game.code)}</p>
          <h2 class="status-title">${escapeHtml(statusMeta.title)}</h2>
          <p class="subtitle">${escapeHtml(statusMeta.copy)}</p>
        </div>

        <div class="meta-row">
          <span class="chip chip-accent">${escapeHtml(state.session.playerName)}</span>
          ${isHost() ? '<span class="chip chip-teal">Host</span>' : ""}
          <button class="btn btn-small btn-secondary" data-action="copy-link">${isLocalFileMode() ? "Kopieer code" : "Kopieer link"}</button>
          <button class="btn btn-small btn-outline" data-action="leave-game">Verlaat spel</button>
        </div>
      </div>

      <div class="phase-row">${getPhaseChips()}</div>

      <div class="meta-row">
        <span class="chip chip-muted">${state.players.length} spelers</span>
        <span class="chip chip-muted">${activeEvents.length} actieve gebeurtenissen</span>
        <span class="chip chip-muted">${triggeredCount} gemarkeerd</span>
        ${requiredCount ? `<span class="chip chip-muted">Kaart ${state.game.board_size}x${state.game.board_size}</span>` : ""}
      </div>
    </section>

    ${
      isLocalFileMode()
        ? `
            <section class="panel panel-pad stack">
              <div>
                <p class="eyebrow">Uitnodigen</p>
                <h3>Je draait nu lokaal vanaf deze computer</h3>
                <p class="subtitle">
                  De huidige URL werkt niet op andere telefoons. Zet deze app op een publieke URL en vul die hierboven in bij
                  "Publieke app URL", of host de map via een bereikbare webserver.
                </p>
              </div>
              <div class="meta-row">
                <span class="chip chip-accent">Deel voorlopig alleen code ${escapeHtml(state.game.code)}</span>
              </div>
            </section>
          `
        : ""
    }

    ${state.game.status === "playing" ? renderAwardsPanel() : ""}
    ${renderHostPanel(scoreRows, activeEvents.length)}
    ${renderStagePanel()}
    ${renderScoreboard(scoreRows, requiredCount)}
  `;
}

function renderAwardsPanel() {
  const lineAwards = getAwardsByType("line");
  const fullCardAwards = getAwardsByType("full_card");

  return `
    <section class="split">
      ${renderAwardColumn("Eerste rij", "Geldt voor horizontaal, verticaal en beide diagonalen.", lineAwards)}
      ${renderAwardColumn("Volle kaart", "Volledige kaarten krijgen doorlopende plekken. Het spel stopt dus niet na plek 1.", fullCardAwards)}
    </section>
  `;
}

function renderAwardColumn(title, description, awards) {
  return `
    <article class="panel panel-pad stack">
      <div>
        <p class="eyebrow">Ranglijst</p>
        <h3>${escapeHtml(title)}</h3>
        <p class="subtitle">${escapeHtml(description)}</p>
      </div>

      ${
        awards.length
          ? `
              <ul class="score-list">
                ${awards
                  .map(
                    (award) => `
                      <li class="score-item is-winner">
                        <div class="score-head">
                          <div>
                            <p class="score-name">#${award.placement} ${escapeHtml(getPlayerName(award.player_id))}</p>
                            <p class="score-meta">Behaald tijdens het spel</p>
                          </div>
                        </div>
                      </li>
                    `
                  )
                  .join("")}
              </ul>
            `
          : '<div class="notice">Nog niemand heeft deze mijlpaal gehaald.</div>'
      }
    </article>
  `;
}

function renderHostPanel(scoreRows, activeCount) {
  if (!isHost()) {
    return "";
  }

  if (state.game.status === "collecting_events") {
    return `
      <section class="panel panel-pad stack">
        <div class="title-row">
          <div>
            <p class="eyebrow">Host acties</p>
            <h3>Sluit de gebeurtenissenfase</h3>
            <p class="subtitle">Sluit pas als de groep klaar is. Je hebt minimaal 9 gebeurtenissen nodig.</p>
          </div>
          <span class="chip ${activeCount >= 9 ? "chip-success" : "chip-muted"}">${activeCount}/9 minimum</span>
        </div>

        <div class="button-row">
          <button class="btn btn-primary" data-action="close-events" ${state.isMutating ? "disabled" : ""}>
            Gebeurtenissenfase sluiten
          </button>
        </div>
      </section>
    `;
  }

  if (state.game.status === "choosing_board_size") {
    return `
      <section class="panel panel-pad stack">
        <div>
          <p class="eyebrow">Host acties</p>
          <h3>Kies het kaartformaat</h3>
          <p class="subtitle">Na deze stap gaan spelers hun persoonlijke kaarten kiezen.</p>
        </div>

        <div class="button-row">
          <button
            class="btn btn-primary"
            data-action="pick-size"
            data-size="3"
            ${state.isMutating || activeCount < 9 ? "disabled" : ""}
          >
            Start 3x3
          </button>
          <button
            class="btn btn-secondary"
            data-action="pick-size"
            data-size="4"
            ${state.isMutating || activeCount < 16 ? "disabled" : ""}
          >
            Start 4x4
          </button>
        </div>

        <p class="helper">3x3 heeft 9 gebeurtenissen nodig. 4x4 heeft er 16 nodig.</p>
      </section>
    `;
  }

  if (state.game.status === "building_cards") {
    const readyPlayers = scoreRows.filter((row) => row.ready).length;

    return `
      <section class="panel panel-pad stack">
        <div class="title-row">
          <div>
            <p class="eyebrow">Host acties</p>
            <h3>Start het spel zodra iedereen klaar is</h3>
            <p class="subtitle">Kaarten blijven aanpasbaar totdat jij start. Daarna kunnen alleen gebeurtenissen nog gemarkeerd worden.</p>
          </div>
          <span class="chip ${allPlayersReady() ? "chip-success" : "chip-muted"}">${readyPlayers}/${scoreRows.length} klaar</span>
        </div>

        <div class="button-row">
          <button class="btn btn-success" data-action="start-game" ${state.isMutating || !allPlayersReady() ? "disabled" : ""}>
            Start spel
          </button>
        </div>
      </section>
    `;
  }

  return "";
}

function renderStagePanel() {
  if (state.game.status === "building_cards") {
    return renderBuildCardsStage();
  }

  if (state.game.status === "playing" || state.game.status === "finished") {
    return renderPlayingStage();
  }

  return renderEventsStage();
}

function renderEventsStage() {
  return `
    <section class="split">
      ${renderEventListPanel(true)}
      <article class="panel panel-pad stack">
        <div>
          <p class="eyebrow">Persoonlijke kaart</p>
          <h3>Nog niet actief</h3>
          <p class="subtitle">
            De bingokaart wordt pas samengesteld nadat de gebeurtenissenlijst is gesloten en het formaat is gekozen.
          </p>
        </div>

        <div class="notice">
          Iedereen kijkt nu naar dezelfde lijst. Alleen de host kan deze fase afsluiten of later het formaat kiezen.
        </div>
      </article>
    </section>
  `;
}

function renderBuildCardsStage() {
  const requiredCount = getRequiredCount();
  const selectionCount = state.draftSelectionIds.length;

  return `
    <section class="split">
      <article class="panel panel-pad stack">
        <div class="title-row">
          <div>
            <p class="eyebrow">Kaart kiezen</p>
            <h3>Jouw kaart van ${state.game.board_size}x${state.game.board_size}</h3>
            <p class="subtitle">Kies exact ${requiredCount} gebeurtenissen. Houd daarna een vakje vast en sleep het naar een andere plek.</p>
          </div>
          <span class="chip ${selectionCount === requiredCount ? "chip-success" : "chip-accent"}">
            ${selectionCount}/${requiredCount} gekozen
          </span>
        </div>

        ${renderCardPreview(state.draftSelectionIds, true)}

        <div class="button-row">
          <button class="btn btn-primary" data-action="save-card" ${state.isMutating || selectionCount !== requiredCount ? "disabled" : ""}>
            Kaart opslaan
          </button>
          ${state.draftDirty ? '<span class="chip chip-accent">Nog niet opgeslagen</span>' : '<span class="chip chip-muted">Opgeslagen selectie geladen</span>'}
        </div>
      </article>

      ${renderSelectionPanel()}
    </section>
  `;
}

function renderPlayingStage() {
  return `
    <section class="layout-play">
      ${renderEventListPanel(false)}
      ${renderPersonalBoardPanel()}
    </section>
  `;
}

function renderSelectionPanel() {
  const activeEvents = getActiveEvents();
  const requiredCount = getRequiredCount();

  return `
    <article class="panel panel-pad stack">
      <div>
        <p class="eyebrow">Beschikbare gebeurtenissen</p>
        <h3>Klik om toe te voegen of te verwijderen</h3>
        <p class="subtitle">Alleen actieve gebeurtenissen tellen mee. Host-correcties worden live doorgevoerd.</p>
      </div>

      ${
        activeEvents.length
          ? `<ul class="selection-list">${activeEvents.map((event) => renderSelectionItem(event, requiredCount)).join("")}</ul>`
          : '<div class="notice">Er zijn nog geen actieve gebeurtenissen om uit te kiezen.</div>'
      }
    </article>
  `;
}

function renderSelectionItem(event, requiredCount) {
  const currentIndex = state.draftSelectionIds.indexOf(event.id);
  const isSelected = currentIndex >= 0;
  const isFull = state.draftSelectionIds.length >= requiredCount;
  const disabled = !isSelected && isFull;

  return `
    <li class="selection-item">
      <button
        class="selection-button ${isSelected ? "is-selected" : ""}"
        data-action="toggle-card-event"
        data-event-id="${event.id}"
        ${disabled || state.isMutating ? "disabled" : ""}
      >
        <span class="selection-order">${isSelected ? currentIndex + 1 : "+"}</span>
        <span>${escapeHtml(event.text)}</span>
      </button>
    </li>
  `;
}

function renderEventListPanel(showAddForm) {
  const activeEvents = getActiveEvents();

  return `
    <article class="panel panel-pad stack">
      <div class="title-row">
        <div>
          <p class="eyebrow">Gebeurtenissenlijst</p>
          <h3>Gezamenlijke lijst voor alle spelers</h3>
          <p class="subtitle">Alleen deze lijst kan handmatig gemarkeerd worden. Kaartvakjes volgen daarna automatisch.</p>
        </div>
        <span class="chip chip-muted">${activeEvents.length} zichtbaar</span>
      </div>

      ${
        showAddForm && state.game.status === "collecting_events"
          ? `
              <form data-form="add-event" class="stack">
                <label class="input-group">
                  <span class="input-label">Nieuwe gebeurtenis</span>
                  <input
                    class="text-input"
                    type="text"
                    name="eventText"
                    maxlength="60"
                    placeholder="Bijvoorbeeld iemand morst drinken"
                    ${state.isMutating ? "disabled" : ""}
                    required
                  >
                </label>

                <div class="button-row">
                  <button class="btn btn-primary" type="submit" ${state.isMutating ? "disabled" : ""}>Toevoegen</button>
                  <p class="helper tiny">Maximaal 60 tekens. Exacte dubbels worden geweigerd.</p>
                </div>
              </form>
            `
          : ""
      }

      ${
        activeEvents.length
          ? `<ul class="event-list">${activeEvents.map((event) => renderEventItem(event)).join("")}</ul>`
          : '<div class="notice">De lijst is nog leeg. Voeg samen nieuwe gebeurtenissen toe om de lobby te vullen.</div>'
      }
    </article>
  `;
}

function renderEventItem(event) {
  const triggeredByText = event.triggered
    ? `Gemarkeerd door ${getPlayerName(event.triggered_by_player_id)}`
    : `Toegevoegd door ${getPlayerName(event.created_by_player_id)}`;
  const isMergeSource = state.mergeSourceEventId === event.id;
  const canChooseTarget = canHostEditEvents() && state.mergeSourceEventId && !isMergeSource;

  return `
    <li class="event-item ${event.triggered ? "is-triggered" : ""}">
      <div class="event-head">
        <div>
          <p class="event-text">${escapeHtml(event.text)}</p>
          <p class="event-meta">${escapeHtml(triggeredByText)}</p>
        </div>
        ${
          event.triggered
            ? '<span class="chip chip-success">Gebeurd</span>'
            : state.game.status === "playing"
              ? `<button class="btn btn-small btn-success" data-action="trigger-event" data-event-id="${event.id}" ${state.isMutating ? "disabled" : ""}>Gebeurd</button>`
              : '<span class="chip chip-muted">Nog niet actief</span>'
        }
      </div>

      ${
        canHostEditEvents()
          ? `
              <div class="event-actions">
                <button class="btn btn-small btn-outline" data-action="edit-event" data-event-id="${event.id}" ${state.isMutating ? "disabled" : ""}>
                  Tekst aanpassen
                </button>
                ${
                  isMergeSource
                    ? `<button class="btn btn-small btn-danger" data-action="cancel-merge" ${state.isMutating ? "disabled" : ""}>Samenvoegen annuleren</button>`
                    : canChooseTarget
                      ? `<button class="btn btn-small btn-secondary" data-action="merge-into-target" data-event-id="${event.id}" ${state.isMutating ? "disabled" : ""}>Voeg bron hierin samen</button>`
                      : `<button class="btn btn-small btn-secondary" data-action="choose-merge-source" data-event-id="${event.id}" ${state.isMutating ? "disabled" : ""}>Kies als merge-bron</button>`
                }
                ${isMergeSource ? '<span class="chip chip-accent">Bron geselecteerd</span>' : ""}
              </div>
            `
          : ""
      }
    </li>
  `;
}

function renderPersonalBoardPanel() {
  const myEntries = getMyCardEntries();
  const checkedCount = myEntries.filter((entry) => entry.checked).length;
  const requiredCount = getRequiredCount();
  const myLineAward = getPlayerAward(state.session.playerId, "line");
  const myFullCardAward = getPlayerAward(state.session.playerId, "full_card");

  return `
    <article class="panel panel-pad stack">
      <div class="title-row">
        <div>
          <p class="eyebrow">Jouw bingokaart</p>
          <h3>${escapeHtml(state.session.playerName)}</h3>
          <p class="subtitle">Vakjes zijn read-only en reageren alleen op de wereldwijde gebeurtenissenlijst.</p>
        </div>
        <span class="chip ${checkedCount === requiredCount && requiredCount ? "chip-success" : "chip-accent"}">
          ${checkedCount}/${requiredCount} afgevinkt
        </span>
      </div>

      <div class="meta-row">
        ${myLineAward ? `<span class="chip chip-teal">Rij #${myLineAward.placement}</span>` : '<span class="chip chip-muted">Nog geen rij-prijs</span>'}
        ${myFullCardAward ? `<span class="chip chip-success">Volle kaart #${myFullCardAward.placement}</span>` : '<span class="chip chip-muted">Nog geen volle-kaart-prijs</span>'}
      </div>

      ${renderCardPreview(myEntries.map((entry) => entry.event_id), false)}
    </article>
  `;
}

function renderCardPreview(sourceEventIds, isDraft) {
  const size = state.game?.board_size || 3;
  const requiredCount = getRequiredCount();
  const eventMap = new Map(getActiveEvents().map((event) => [event.id, event]));
  const myEntriesByEventId = new Map(getMyCardEntries().map((entry) => [entry.event_id, entry]));

  const cells = Array.from({ length: requiredCount }, (_, index) => {
    const eventId = sourceEventIds[index];
    const event = eventMap.get(eventId);
    const entry = eventId ? myEntriesByEventId.get(eventId) : null;
    const checked = Boolean(entry?.checked);
    const hit = entry && state.recentEntryIds.includes(entry.id);
    const isDragSource = isDraft && state.drag.active && state.drag.sourceIndex === index;
    const isDragTarget = isDraft && state.drag.active && state.drag.overIndex === index && state.drag.sourceIndex !== index;

    const classes = [
      "board-cell",
      event ? "" : "is-empty",
      checked ? "is-checked" : "",
      hit ? "is-hit" : "",
      isDraft && event ? "is-draft" : "",
      isDragSource ? "is-drag-source" : "",
      isDragTarget ? "is-drag-target" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return `
      <div
        class="${classes}"
        ${isDraft ? `data-draft-slot="${index}" data-has-event="${event ? "true" : "false"}" data-draft-label="${escapeHtml(event?.text ?? "")}"` : ""}
      >
        ${checked && !isDraft ? '<span class="board-check">&#10003;</span>' : ""}
        <span>${escapeHtml(event?.text ?? "Leeg vak")}</span>
      </div>
    `;
  }).join("");

  return `
    <div class="board-grid board-${size}">
      ${cells}
    </div>
    ${
      isDraft && state.drag.active
        ? `<div class="drag-ghost" style="transform: translate(${state.drag.ghostX - 84}px, ${state.drag.ghostY - 40}px);">${escapeHtml(state.drag.ghostText)}</div>`
        : ""
    }
  `;
}

function renderScoreboard(scoreRows, requiredCount) {
  return `
    <section class="panel panel-pad stack">
      <div class="title-row">
        <div>
          <p class="eyebrow">Scorebord</p>
          <h3>Voortgang van alle spelers</h3>
          <p class="subtitle">Tijdens het samenstellen zie je wie klaar is. Tijdens het spel zie je hoeveel vakjes per speler geraakt zijn.</p>
        </div>
      </div>

      ${
        scoreRows.length
          ? `
              <ul class="score-list">
                ${scoreRows
                  .map((row) => {
                    const meta =
                      state.game.status === "building_cards"
                        ? `${row.selectedCount}/${requiredCount} gekozen`
                        : requiredCount
                          ? `${row.checkedCount}/${requiredCount} afgevinkt`
                          : `${row.selectedCount} gekozen`;
                    const hasAward = Boolean(row.lineAward || row.fullCardAward);

                    return `
                      <li class="score-item ${hasAward ? "is-winner" : ""}">
                        <div class="score-head">
                          <div>
                            <p class="score-name">${escapeHtml(row.player.name)}</p>
                            <p class="score-meta">${escapeHtml(meta)}</p>
                          </div>
                          <div class="meta-row">
                            ${row.ready ? '<span class="chip chip-success">Klaar</span>' : ""}
                            ${row.lineAward ? `<span class="chip chip-teal">Rij #${row.lineAward.placement}</span>` : ""}
                            ${row.fullCardAward ? `<span class="chip chip-accent">Volle kaart #${row.fullCardAward.placement}</span>` : ""}
                          </div>
                        </div>
                      </li>
                    `;
                  })
                  .join("")}
              </ul>
            `
          : '<div class="notice">Nog geen spelers gevonden.</div>'
      }
    </section>
  `;
}

async function handleSubmit(event) {
  const form = event.target;
  const formName = form?.dataset?.form;

  if (!formName) {
    return;
  }

  event.preventDefault();

  if (state.isMutating) {
    return;
  }

  if (formName === "save-config") {
    const formData = new FormData(form);
    const url = String(formData.get("url") || "").trim();
    const anonKey = String(formData.get("anonKey") || "").trim();
    const publicAppUrl = String(formData.get("publicAppUrl") || "").trim();

    state.config = { url, anonKey, publicAppUrl };
    saveJson(STORAGE_KEYS.config, state.config);
    connectSupabase();
    pushToast("Supabase instellingen opgeslagen.", "success");

    if (state.session?.gameId) {
      await restoreSession();
    }

    render();
    return;
  }

  if (!state.supabase) {
    pushToast("Koppel eerst Supabase.", "error");
    return;
  }

  if (formName === "create-game") {
    const formData = new FormData(form);
    const name = String(formData.get("name") || "").trim();
    await createGame(name);
    return;
  }

  if (formName === "join-game") {
    const formData = new FormData(form);
    const name = String(formData.get("name") || "").trim();
    const code = String(formData.get("code") || "").trim().toUpperCase();
    await joinGame(code, name);
    return;
  }

  if (formName === "add-event") {
    const formData = new FormData(form);
    const eventText = String(formData.get("eventText") || "").trim();
    await addEvent(eventText);
  }
}

async function handleClick(event) {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    return;
  }

  const action = actionTarget.dataset.action;
  const eventId = actionTarget.dataset.eventId || "";
  const size = Number(actionTarget.dataset.size);

  if (action === "leave-game") {
    if (!window.confirm("Weet je zeker dat je deze lokale sessie wilt verlaten?")) {
      return;
    }

    clearSession({ keepUrlCode: false });
    render();
    return;
  }

  if (action === "copy-link") {
    try {
      if (isLocalFileMode()) {
        await navigator.clipboard.writeText(state.game.code);
        pushToast("Spelcode gekopieerd. De URL zelf werkt nu alleen op jouw computer.", "info");
      } else {
        await navigator.clipboard.writeText(getShareUrl());
        pushToast("Link gekopieerd.", "success");
      }
    } catch (error) {
      pushToast("Kopieren lukt niet op dit apparaat.", "error");
    }
    return;
  }

  if (state.isMutating || !state.supabase || !state.session || !state.game) {
    return;
  }

  if (action === "close-events") {
    if (!window.confirm("Sluit je de gebeurtenissenfase nu echt? Daarna kan niemand meer toevoegen.")) {
      return;
    }

    await closeEvents();
    return;
  }

  if (action === "pick-size") {
    await setBoardSize(size);
    return;
  }

  if (action === "save-card") {
    await saveCard();
    return;
  }

  if (action === "start-game") {
    if (!window.confirm("Start je het spel nu? Daarna worden kaarten vergrendeld.")) {
      return;
    }

    await startGame();
    return;
  }

  if (action === "trigger-event") {
    await triggerEvent(eventId);
    return;
  }

  if (action === "toggle-card-event") {
    toggleCardEvent(eventId);
    return;
  }

  if (action === "edit-event") {
    const currentEvent = getActiveEvents().find((item) => item.id === eventId);
    if (!currentEvent) {
      return;
    }

    const newText = window.prompt("Nieuwe tekst voor deze gebeurtenis:", currentEvent.text);
    if (newText === null) {
      return;
    }

    await editEvent(eventId, newText);
    return;
  }

  if (action === "choose-merge-source") {
    state.mergeSourceEventId = eventId;
    render();
    return;
  }

  if (action === "cancel-merge") {
    state.mergeSourceEventId = null;
    render();
    return;
  }

  if (action === "merge-into-target") {
    const sourceEvent = getActiveEvents().find((item) => item.id === state.mergeSourceEventId);
    const targetEvent = getActiveEvents().find((item) => item.id === eventId);

    if (!sourceEvent || !targetEvent) {
      pushToast("Kies eerst twee actieve gebeurtenissen.", "error");
      return;
    }

    const targetText = window.prompt(
      `Definitieve tekst na samenvoegen van "${sourceEvent.text}" naar "${targetEvent.text}":`,
      targetEvent.text
    );

    if (targetText === null) {
      return;
    }

    await mergeEvents(state.mergeSourceEventId, eventId, targetText);
  }
}

async function createGame(name) {
  await runMutation(async () => {
    const { data, error } = await state.supabase.rpc("create_game_with_host", {
      p_host_name: name,
    });

    if (error) {
      throw error;
    }

    const sessionRow = Array.isArray(data) ? data[0] : data;
    persistSession(sessionRow);
    await loadSnapshot();
    setupRealtime();
    pushToast(`Lobby ${sessionRow.code} is aangemaakt.`, "success");
  });
}

async function joinGame(code, name) {
  await runMutation(async () => {
    const { data, error } = await state.supabase.rpc("join_game_with_code", {
      p_code: code,
      p_name: name,
    });

    if (error) {
      throw error;
    }

    const sessionRow = Array.isArray(data) ? data[0] : data;
    persistSession(sessionRow);
    await loadSnapshot();
    setupRealtime();
    pushToast(`Je bent gejoind in spel ${sessionRow.code}.`, "success");
  });
}

async function addEvent(text) {
  await runMutation(async () => {
    const { error } = await state.supabase.rpc("add_event", {
      p_game_id: state.session.gameId,
      p_player_id: state.session.playerId,
      p_session_token: state.session.sessionToken,
      p_text: text,
    });

    if (error) {
      throw error;
    }

    pushToast("Gebeurtenis toegevoegd.", "success");
    await loadSnapshot();
  });
}

async function closeEvents() {
  await runMutation(async () => {
    const { error } = await state.supabase.rpc("close_event_collection", {
      p_game_id: state.session.gameId,
      p_player_id: state.session.playerId,
      p_session_token: state.session.sessionToken,
    });

    if (error) {
      throw error;
    }

    state.mergeSourceEventId = null;
    await loadSnapshot();
    pushToast("Gebeurtenissenfase gesloten.", "success");
  });
}

async function setBoardSize(boardSize) {
  await runMutation(async () => {
    const { error } = await state.supabase.rpc("set_board_size", {
      p_game_id: state.session.gameId,
      p_player_id: state.session.playerId,
      p_session_token: state.session.sessionToken,
      p_board_size: boardSize,
    });

    if (error) {
      throw error;
    }

    await loadSnapshot();
    pushToast(`Kaartformaat ${boardSize}x${boardSize} gekozen.`, "success");
  });
}

function toggleCardEvent(eventId) {
  const currentIds = [...state.draftSelectionIds];
  const requiredCount = getRequiredCount();
  const existingIndex = currentIds.indexOf(eventId);

  if (existingIndex >= 0) {
    currentIds.splice(existingIndex, 1);
  } else {
    if (currentIds.length >= requiredCount) {
      pushToast(`Je kaart zit al vol met ${requiredCount} gebeurtenissen.`, "info");
      return;
    }

    currentIds.push(eventId);
  }

  state.draftSelectionIds = currentIds;
  state.draftDirty = true;
  render();
}

function moveDraftItem(sourceIndex, targetIndex) {
  const currentIds = [...state.draftSelectionIds];

  if (
    sourceIndex < 0 ||
    targetIndex < 0 ||
    sourceIndex >= currentIds.length ||
    targetIndex >= currentIds.length ||
    sourceIndex === targetIndex
  ) {
    return;
  }

  [currentIds[sourceIndex], currentIds[targetIndex]] = [currentIds[targetIndex], currentIds[sourceIndex]];
  state.draftSelectionIds = currentIds;
  state.draftDirty = true;
}

function handleDraftPointerDown(event) {
  if (state.game?.status !== "building_cards") {
    return;
  }

  const slot = event.target.closest("[data-draft-slot]");
  if (!slot || slot.dataset.hasEvent !== "true") {
    return;
  }

  const sourceIndex = Number(slot.dataset.draftSlot);
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= state.draftSelectionIds.length) {
    return;
  }

  state.drag.active = true;
  state.drag.pointerId = event.pointerId;
  state.drag.sourceIndex = sourceIndex;
  state.drag.overIndex = sourceIndex;
  state.drag.ghostText = slot.dataset.draftLabel || "";
  state.drag.ghostX = event.clientX;
  state.drag.ghostY = event.clientY;
  document.body.style.userSelect = "none";
  document.body.style.touchAction = "none";
  slot.classList.add("is-drag-source");
  event.preventDefault();
  render();
}

function handleDraftPointerMove(event) {
  if (!state.drag.active || event.pointerId !== state.drag.pointerId) {
    return;
  }

  event.preventDefault();
  state.drag.ghostX = event.clientX;
  state.drag.ghostY = event.clientY;

  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-draft-slot]");
  const nextIndex = target ? Number(target.dataset.draftSlot) : -1;

  if (
    Number.isInteger(nextIndex) &&
    nextIndex >= 0 &&
    nextIndex < state.draftSelectionIds.length
  ) {
    state.drag.overIndex = nextIndex;
  } else {
    state.drag.overIndex = state.drag.sourceIndex;
  }

  render();
}

function handleDraftPointerUp(event) {
  if (!state.drag.active || event.pointerId !== state.drag.pointerId) {
    return;
  }

  event.preventDefault();
  const sourceIndex = state.drag.sourceIndex;
  const targetIndex = state.drag.overIndex;

  if (sourceIndex !== targetIndex) {
    moveDraftItem(sourceIndex, targetIndex);
  }

  resetDraftDrag(false);
  render();
}

function resetDraftDrag(shouldRender = true) {
  state.drag.active = false;
  state.drag.pointerId = null;
  state.drag.sourceIndex = -1;
  state.drag.overIndex = -1;
  state.drag.ghostText = "";
  state.drag.ghostX = 0;
  state.drag.ghostY = 0;
  document.body.style.userSelect = "";
  document.body.style.touchAction = "";

  if (shouldRender) {
    render();
  }
}

async function saveCard() {
  await runMutation(async () => {
    const { error } = await state.supabase.rpc("save_player_card", {
      p_game_id: state.session.gameId,
      p_player_id: state.session.playerId,
      p_session_token: state.session.sessionToken,
      p_event_ids: state.draftSelectionIds,
    });

    if (error) {
      throw error;
    }

    state.draftDirty = false;
    await loadSnapshot();
    pushToast("Jouw kaart is opgeslagen.", "success");
  });
}

async function startGame() {
  await runMutation(async () => {
    const { error } = await state.supabase.rpc("start_game", {
      p_game_id: state.session.gameId,
      p_player_id: state.session.playerId,
      p_session_token: state.session.sessionToken,
    });

    if (error) {
      throw error;
    }

    await loadSnapshot();
    pushToast("Het spel is gestart.", "success");
  });
}

async function triggerEvent(eventId) {
  await runMutation(async () => {
    const { error } = await state.supabase.rpc("trigger_event", {
      p_game_id: state.session.gameId,
      p_event_id: eventId,
      p_player_id: state.session.playerId,
      p_session_token: state.session.sessionToken,
    });

    if (error) {
      throw error;
    }

    await loadSnapshot();
  });
}

async function editEvent(eventId, newText) {
  await runMutation(async () => {
    const { error } = await state.supabase.rpc("edit_event_text", {
      p_game_id: state.session.gameId,
      p_event_id: eventId,
      p_player_id: state.session.playerId,
      p_session_token: state.session.sessionToken,
      p_new_text: newText,
    });

    if (error) {
      throw error;
    }

    await loadSnapshot();
    pushToast("Gebeurtenistekst aangepast.", "success");
  });
}

async function mergeEvents(sourceEventId, targetEventId, targetText) {
  await runMutation(async () => {
    const { error } = await state.supabase.rpc("merge_events", {
      p_game_id: state.session.gameId,
      p_source_event_id: sourceEventId,
      p_target_event_id: targetEventId,
      p_player_id: state.session.playerId,
      p_session_token: state.session.sessionToken,
      p_target_text: targetText,
    });

    if (error) {
      throw error;
    }

    state.mergeSourceEventId = null;
    await loadSnapshot();
    pushToast("Gebeurtenissen zijn samengevoegd.", "success");
  });
}

async function runMutation(task) {
  state.isMutating = true;
  render();

  try {
    await task();
  } catch (error) {
    pushToast(normalizeError(error, "Er ging iets mis."), "error");
  } finally {
    state.isMutating = false;
    render();
  }
}

function normalizeError(error, fallback) {
  const message = String(error?.message || "").trim();
  return message || fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
