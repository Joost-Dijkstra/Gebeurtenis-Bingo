const STORAGE_KEYS = {
  config: "party-bingo-config",
  session: "party-bingo-session",
  lastName: "party-bingo-last-name",
};

const DEFAULT_CONFIG = {
  url: "https://jkysqjzzowqcimxwjroz.supabase.co",
  anonKey: "sb_publishable_t4A4ufm2IJV1p9ILWrKANQ_tjNBmBhC",
  publicAppUrl: "https://joost-dijkstra.github.io/Gebeurtenis-Bingo/",
};

const REFRESH_DELAY_MS = 180;
const POLL_INTERVAL_MS = 1200;
const TOAST_LIFETIME_MS = 3200;

const appElement = document.querySelector("#app");
const toastElement = document.querySelector("#toast-stack");
let deferredInstallPrompt = null;
let serviceWorkerRegistrationTask = null;

const state = {
  config: { ...DEFAULT_CONFIG, ...(loadJson(STORAGE_KEYS.config) ?? {}) },
  session: loadJson(STORAGE_KEYS.session),
  lastName: localStorage.getItem(STORAGE_KEYS.lastName) ?? "",
  prefillCode: readCodeFromUrl(),
  activeTab: "kaart",
  eventSearch: "",
  eventDraftText: "",
  gameInfoCollapsed: false,
  showInviteSheet: false,
  showSettingsSheet: false,
  supabase: null,
  game: null,
  players: [],
  events: [],
  cardEntries: [],
  awards: [],
  channel: null,
  refreshTimer: null,
  pollTimer: null,
  finishTimer: null,
  recentHitTimer: null,
  awardTimer: null,
  isHydrating: false,
  isMutating: false,
  draftSelectionIds: [],
  draftDirty: false,
  mergeSourceEventId: null,
  recentEntryIds: [],
  justFinished: false,
  awardSpotlight: null,
  canInstall: false,
  isStandalone: false,
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

const INTERACTIVE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

document.addEventListener("submit", handleSubmit);
document.addEventListener("click", handleClick);
document.addEventListener("input", handleInput);
document.addEventListener("pointerdown", handleDraftPointerDown);
document.addEventListener("pointermove", handleDraftPointerMove);
document.addEventListener("pointerup", handleDraftPointerUp);
document.addEventListener("pointercancel", handleDraftPointerUp);
window.addEventListener("load", () => {
  registerServiceWorker();
});

boot();

async function boot() {
  syncDisplayModeState();
  setupInstallSupport();
  registerServiceWorker();
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

function syncDisplayModeState() {
  state.isStandalone =
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true;
}

function setupInstallSupport() {
  if (setupInstallSupport.initialized) {
    return;
  }

  setupInstallSupport.initialized = true;

  if (window.matchMedia) {
    const displayModeMedia = window.matchMedia("(display-mode: standalone)");
    const handleModeChange = () => {
      syncDisplayModeState();
      if (state.isStandalone) {
        deferredInstallPrompt = null;
        state.canInstall = false;
      }
      render();
    };

    if (displayModeMedia.addEventListener) {
      displayModeMedia.addEventListener("change", handleModeChange);
    } else if (displayModeMedia.addListener) {
      displayModeMedia.addListener(handleModeChange);
    }
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    syncDisplayModeState();
    state.canInstall = !state.isStandalone;
    render();
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    syncDisplayModeState();
    state.canInstall = false;
    render();
    pushToast("App geinstalleerd.", "success");
  });
}

function getGameDisplayName(game = state.game) {
  if (!game) {
    return "";
  }

  return String(game.name || "").trim() || `Spel ${game.code}`;
}

function canHostManagePlayers() {
  return isHost() && ["collecting_events", "choosing_board_size", "building_cards"].includes(state.game?.status);
}

function hasHostToolsSupport() {
  return Boolean(
    state.game &&
      Object.prototype.hasOwnProperty.call(state.game, "name")
  );
}

function isInteractiveFieldActive() {
  const activeElement = document.activeElement;

  if (!(activeElement instanceof HTMLElement)) {
    return false;
  }

  if (!appElement.contains(activeElement)) {
    return false;
  }

  if (!INTERACTIVE_TAGS.has(activeElement.tagName)) {
    return activeElement.isContentEditable;
  }

  return !activeElement.hasAttribute("readonly") && !activeElement.hasAttribute("disabled");
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || window.location.protocol === "file:") {
    return;
  }

  if (serviceWorkerRegistrationTask) {
    return serviceWorkerRegistrationTask;
  }

  try {
    serviceWorkerRegistrationTask = navigator.serviceWorker.register("./sw.js");
    await serviceWorkerRegistrationTask;
  } catch (error) {
    serviceWorkerRegistrationTask = null;
    console.error("Service worker registreren mislukte.", error);
  }
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
  const snapshot = await fetchGameSnapshot(gameId);

  state.game = snapshot.game;
  state.players = snapshot.players ?? [];
  state.events = snapshot.events ?? [];
  state.cardEntries = snapshot.cardEntries ?? [];
  state.awards = snapshot.awards ?? [];

  if (!state.players.some((player) => player.id === state.session.playerId)) {
    throw new Error("Deze speler bestaat niet meer in dit spel.");
  }

  state.session.gameCode = state.game.code;
  saveJson(STORAGE_KEYS.session, state.session);
  writeCodeToUrl(state.game.code);

  syncDraftSelection();
  syncActiveTab(previousStatus);
  syncRecentChecks(previousCheckedIds);
  syncAwardUpdates(previousAwardIds, hadLoadedGame);
  syncFinishAnimation(previousStatus);
  render();
}

async function fetchGameSnapshot(gameId) {
  try {
    const { data, error } = await state.supabase.rpc("get_game_snapshot", {
      p_game_id: gameId,
      p_player_id: state.session.playerId,
      p_session_token: state.session.sessionToken,
    });

    if (error) {
      throw error;
    }

    return {
      game: data?.game ?? null,
      players: data?.players ?? [],
      events: data?.events ?? [],
      cardEntries: data?.card_entries ?? [],
      awards: data?.awards ?? [],
    };
  } catch (error) {
    if (!shouldFallbackToLegacySnapshot(error)) {
      throw error;
    }

    return await fetchLegacySnapshot(gameId);
  }
}

function shouldFallbackToLegacySnapshot(error) {
  const message = String(error?.message || error?.details || "");
  const code = String(error?.code || "");

  return (
    message.includes("get_game_snapshot") ||
    message.includes("Could not find the function") ||
    code === "42883"
  );
}

async function fetchLegacySnapshot(gameId) {
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

  return {
    game: gameResult.data,
    players: playersResult.data ?? [],
    events: eventsResult.data ?? [],
    cardEntries: entriesResult.data ?? [],
    awards: awardsResult.data ?? [],
  };
}

function getDefaultTabForStatus(status) {
  switch (status) {
    case "collecting_events":
      return "gebeurtenissen";
    case "choosing_board_size":
      return "lobby";
    case "building_cards":
    case "playing":
    case "finished":
    default:
      return "kaart";
  }
}

function syncActiveTab(previousStatus) {
  const nextStatus = state.game?.status;

  if (!nextStatus) {
    state.activeTab = "kaart";
    return;
  }

  if (!state.activeTab || previousStatus !== nextStatus) {
    state.activeTab = getDefaultTabForStatus(nextStatus);
  }

  if (previousStatus !== nextStatus) {
    state.gameInfoCollapsed = nextStatus === "playing" || nextStatus === "finished";
  }
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
  state.pollTimer = window.setInterval(() => {
    scheduleRefresh();
  }, POLL_INTERVAL_MS);
}

function teardownRealtime() {
  if (state.channel && state.supabase) {
    state.supabase.removeChannel(state.channel);
  }

  state.channel = null;

  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
  }

  state.pollTimer = null;
}

function scheduleRefresh() {
  if (state.refreshTimer) {
    return;
  }

  state.refreshTimer = window.setTimeout(async () => {
    if (isInteractiveFieldActive()) {
      state.refreshTimer = null;
      state.refreshTimer = window.setTimeout(() => {
        state.refreshTimer = null;
        scheduleRefresh();
      }, 700);
      return;
    }

    state.refreshTimer = null;

    try {
      await loadSnapshot();
    } catch (error) {
      if (handleSessionEnded(error)) {
        return;
      }
      pushToast(normalizeError(error, "Kon de speldata niet verversen."), "error");
    }
  }, REFRESH_DELAY_MS);
}

function handleSessionEnded(error) {
  const message = String(error?.message || error?.details || "");

  if (
    message.includes("Ongeldige spelerssessie") ||
    message.includes("Deze speler bestaat niet meer in dit spel") ||
    message.includes("Speler hoort niet bij dit spel")
  ) {
    clearSession({ keepUrlCode: true });
    render();
    pushToast("Je zit niet meer in dit spel.", "info");
    return true;
  }

  return false;
}

function clearSession({ keepUrlCode = false } = {}) {
  teardownRealtime();
  window.clearTimeout(state.refreshTimer);
  window.clearTimeout(state.finishTimer);
  window.clearTimeout(state.recentHitTimer);
  window.clearTimeout(state.awardTimer);

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
  state.awardSpotlight = null;
  state.showInviteSheet = false;
  state.showSettingsSheet = false;
  state.gameInfoCollapsed = false;
  state.eventSearch = "";
  state.eventDraftText = "";
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

function getFilteredEvents() {
  const term = state.eventSearch.trim().toLocaleLowerCase("nl");

  if (!term) {
    return getActiveEvents();
  }

  return getActiveEvents().filter((event) => event.text.toLocaleLowerCase("nl").includes(term));
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
        copy: "Iedereen kan toevoegen.",
      };
    case "choosing_board_size":
      return {
        title: "Formaat kiezen",
        copy: "Host kiest 3x3 of 4x4.",
      };
    case "building_cards":
      return {
        title: "Kaarten samenstellen",
        copy: "Kies je kaart.",
      };
    case "playing":
      return {
        title: "Spel bezig",
        copy: "Alles loopt live mee.",
      };
    case "finished":
      return {
        title: "Bingo gevallen",
        copy: "Bekijk de uitslag.",
      };
    default:
      return {
        title: "Party Bingo",
        copy: "Maak een lobby of join.",
      };
  }
}

function getShortPhaseLabel(status) {
  switch (status) {
    case "collecting_events":
      return "Lijst vullen";
    case "choosing_board_size":
      return "Formaat";
    case "building_cards":
      return "Kaart maken";
    case "playing":
      return "Spelen";
    case "finished":
      return "Uitslag";
    default:
      return "Lobby";
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

  if (freshAwards.length) {
    const featuredAward =
      [...freshAwards].sort((left, right) => {
        if (left.player_id === state.session?.playerId && right.player_id !== state.session?.playerId) {
          return -1;
        }

        if (left.player_id !== state.session?.playerId && right.player_id === state.session?.playerId) {
          return 1;
        }

        if (left.achievement_type === "full_card" && right.achievement_type !== "full_card") {
          return -1;
        }

        if (left.achievement_type !== "full_card" && right.achievement_type === "full_card") {
          return 1;
        }

        return left.placement - right.placement;
      })[0] ?? null;

    if (featuredAward) {
      const isSelf = featuredAward.player_id === state.session?.playerId;
      state.awardSpotlight = {
        playerName: getPlayerName(featuredAward.player_id),
        label: featuredAward.achievement_type === "line" ? "Eerste rij" : "Volle kaart",
        placement: featuredAward.placement,
        isSelf,
      };

      window.clearTimeout(state.awardTimer);
      state.awardTimer = window.setTimeout(() => {
        state.awardSpotlight = null;
        render();
      }, 2600);
    }
  }
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
  const focusState = captureFocusState();
  document.body.classList.toggle("body-in-game", Boolean(state.session?.gameId && state.game));
  document.body.classList.toggle("body-standalone", state.isStandalone);
  document.body.dataset.activeTab = state.session?.gameId && state.game ? state.activeTab : "landing";

  if (!state.session) {
    appElement.innerHTML = renderLobby();
    renderToasts();
    restoreFocusState(focusState);
    return;
  }

  if (state.isHydrating && !state.game) {
    appElement.innerHTML = renderLoadingState();
    renderToasts();
    restoreFocusState(focusState);
    return;
  }

  if (!state.game) {
    appElement.innerHTML = renderLobby();
    renderToasts();
    restoreFocusState(focusState);
    return;
  }

  appElement.innerHTML = renderGameView();
  renderToasts();
  restoreFocusState(focusState);
}

function captureFocusState() {
  const activeElement = document.activeElement;

  if (!(activeElement instanceof HTMLInputElement) && !(activeElement instanceof HTMLTextAreaElement)) {
    return null;
  }

  if (!appElement.contains(activeElement)) {
    return null;
  }

  const formName = activeElement.form?.dataset?.form;
  const fieldName = activeElement.name;

  if (!formName || !fieldName) {
    return null;
  }

  return {
    formName,
    fieldName,
    selectionStart: activeElement.selectionStart,
    selectionEnd: activeElement.selectionEnd,
  };
}

function restoreFocusState(focusState) {
  if (!focusState) {
    return;
  }

  const field = appElement.querySelector(
    `form[data-form="${focusState.formName}"] [name="${focusState.fieldName}"]`
  );

  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) {
    return;
  }

  field.focus({ preventScroll: true });

  if (typeof focusState.selectionStart === "number" && typeof focusState.selectionEnd === "number") {
    field.setSelectionRange(focusState.selectionStart, focusState.selectionEnd);
  }
}

function renderLoadingState() {
  return `
    <section class="panel panel-pad stack">
      <p class="eyebrow">Party Bingo</p>
      <h2>Laden...</h2>
    </section>
  `;
}

function renderLobby() {
  const configReady = isConfigured();
  const buttonDisabled = configReady ? "" : "disabled";

  return `
    ${
      configReady
        ? `
            <section class="lobby-topbar">
              <span class="chip chip-success">Klaar om te spelen</span>
              <div class="meta-row">
                ${renderInstallButton({ small: true })}
                <button class="btn btn-small btn-outline" data-action="open-settings-sheet">Instellingen</button>
              </div>
            </section>
          `
        : renderSettingsPanel(true)
    }

    <section class="split">
      <article class="panel panel-pad stack">
        <div>
          <p class="eyebrow">${configReady ? "1. Spel starten" : "2. Spel starten"}</p>
          <h2>Nieuwe lobby maken</h2>
        </div>

        <form data-form="create-game" class="stack">
          <label class="input-group">
            <span class="input-label">Spelnaam</span>
            <input
              class="text-input"
              type="text"
              name="gameName"
              maxlength="48"
              placeholder="Bijvoorbeeld Feestje Fraya"
            >
          </label>

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
          <p class="eyebrow">${configReady ? "2. Meespelen" : "3. Meespelen"}</p>
          <h2>Join via code</h2>
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

    ${state.showSettingsSheet ? renderSettingsSheet() : ""}
  `;
}

function renderInstallButton({ small = false } = {}) {
  if (state.isStandalone || !state.canInstall) {
    return "";
  }

  return `
    <button class="btn ${small ? "btn-small" : ""} btn-secondary" type="button" data-action="install-app">
      Installeer app
    </button>
  `;
}

function renderSettingsPanel(isPrimary = false) {
  return `
    <section class="panel panel-pad stack ${isPrimary ? "" : "settings-panel-inline"}">
      <div class="title-row">
        <div>
          <p class="eyebrow">Supabase koppelen</p>
          <h2>Projectinstellingen</h2>
        </div>
        <span class="${isConfigured() ? "chip chip-success" : "chip chip-muted"}">
          ${isConfigured() ? "Gekoppeld" : "Niet gekoppeld"}
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
  `;
}

function renderSettingsSheet() {
  return `
    <section class="sheet-backdrop" data-action="close-settings-sheet">
      <article class="invite-sheet panel panel-pad stack" role="dialog" aria-modal="true" aria-label="Instellingen">
        <div class="title-row">
          <div>
            <p class="eyebrow">Instellingen</p>
            <h3>Supabase project</h3>
          </div>
          <button class="btn btn-small btn-outline" data-action="close-settings-sheet">Sluiten</button>
        </div>
        ${renderSettingsPanel(false)}
      </article>
    </section>
  `;
}

function renderGameView() {
  const statusMeta = getStatusMeta();
  const requiredCount = getRequiredCount();
  const scoreRows = getScoreRows();
  const activeEvents = getActiveEvents();

  return `
    <section class="game-shell">
      ${state.awardSpotlight ? renderAwardSpotlight() : ""}

      <section class="tab-screen screen-${state.activeTab}">
        ${renderActiveTab(statusMeta, scoreRows, activeEvents.length, requiredCount)}
      </section>

      ${renderBottomNavigation()}
      ${state.showInviteSheet ? renderInviteSheet() : ""}
    </section>
  `;
}

function renderAwardSpotlight() {
  const spotlight = state.awardSpotlight;

  if (!spotlight) {
    return "";
  }

  return `
    <section class="award-spotlight ${spotlight.label === "Volle kaart" ? "is-grand" : ""}">
      <p class="eyebrow">Rank Up</p>
      <h3>${spotlight.isSelf ? "Jij scoort" : `${escapeHtml(spotlight.playerName)} scoort`}</h3>
      <p class="award-spotlight-label">${escapeHtml(spotlight.label)} #${spotlight.placement}</p>
    </section>
  `;
}

function renderActiveTab(statusMeta, scoreRows, activeCount, requiredCount) {
  switch (state.activeTab) {
    case "gebeurtenissen":
      return renderEventsTab();
    case "ranglijst":
      return renderRankingsTab(scoreRows, requiredCount);
    case "lobby":
      return renderLobbyTab(statusMeta, scoreRows, activeCount, requiredCount);
    case "kaart":
    default:
      return renderCardTab();
  }
}

function renderBottomNavigation() {
  const tabs = [
    ["kaart", "Kaart"],
    ["gebeurtenissen", "Lijst"],
    ["ranglijst", "Stand"],
    ["lobby", "Lobby"],
  ];

  return `
    <nav class="bottom-nav" aria-label="Hoofdnavigatie">
      ${tabs
        .map(
          ([tabId, label]) => `
            <button
              class="bottom-nav-button ${state.activeTab === tabId ? "is-active" : ""}"
              data-action="switch-tab"
              data-tab="${tabId}"
            >
              <span class="bottom-nav-icon" aria-hidden="true">${renderTabIcon(tabId)}</span>
              <span>${label}</span>
            </button>
          `
        )
        .join("")}
    </nav>
  `;
}

function renderTabIcon(tabId) {
  switch (tabId) {
    case "kaart":
      return `
        <svg viewBox="0 0 24 24" focusable="false">
          <rect x="4" y="4" width="16" height="16" rx="3"></rect>
          <path d="M12 4v16M4 12h16"></path>
        </svg>
      `;
    case "gebeurtenissen":
      return `
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M7 6h13M7 12h13M7 18h13"></path>
          <circle cx="4" cy="6" r="1.5"></circle>
          <circle cx="4" cy="12" r="1.5"></circle>
          <circle cx="4" cy="18" r="1.5"></circle>
        </svg>
      `;
    case "ranglijst":
      return `
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M5 19V11M12 19V5M19 19v-8"></path>
        </svg>
      `;
    case "lobby":
    default:
      return `
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M4 18v-1.5a3.5 3.5 0 0 1 3.5-3.5h9a3.5 3.5 0 0 1 3.5 3.5V18"></path>
          <circle cx="12" cy="8" r="3"></circle>
        </svg>
      `;
  }
}

function renderCardTab() {
  if (state.game.status === "building_cards") {
    return renderBuildCardsStage();
  }

  if (state.game.status === "playing" || state.game.status === "finished") {
    return `
      <section class="stack">
        ${state.justFinished ? renderBingoBanner() : ""}
        ${renderPersonalBoardPanel()}
      </section>
    `;
  }

  return `
    <section class="stack">
      <article class="panel panel-pad stack">
        <div>
          <p class="eyebrow">Kaart</p>
          <h3>Nog niet actief</h3>
        </div>
        <div class="notice">Nog niet beschikbaar.</div>
      </article>
    </section>
  `;
}

function renderEventsTab() {
  if (state.game.status === "building_cards") {
    return `
      <section class="stack">
        ${renderSelectionPanel()}
      </section>
    `;
  }

  return `
    <section class="stack">
      ${renderEventListPanel(state.game.status === "collecting_events")}
    </section>
  `;
}

function renderRankingsTab(scoreRows, requiredCount) {
  return `
    <section class="stack">
      ${state.game.status === "playing" || state.game.status === "finished" ? renderAwardsPanel() : ""}
      ${renderScoreboard(scoreRows, requiredCount)}
    </section>
  `;
}

function renderLobbyTab(statusMeta, scoreRows, activeCount, requiredCount) {
  return `
    <section class="stack">
      <article class="panel panel-pad stack">
        <div class="title-row">
          <div>
            <p class="eyebrow">Lobby</p>
            <h3>${escapeHtml(getGameDisplayName())}</h3>
          </div>
          <span class="chip chip-accent">${escapeHtml(state.game.code)}</span>
        </div>

        <div class="phase-row">${getPhaseChips()}</div>

        <div class="compact-stats">
          <span class="chip chip-muted">${escapeHtml(getShortPhaseLabel(state.game.status))}</span>
          <span class="chip chip-muted">${state.players.length} spelers</span>
          <span class="chip chip-muted">${state.events.filter((event) => event.triggered).length}/${activeCount} gebeurd</span>
          ${requiredCount ? `<span class="chip chip-muted">Kaart ${state.game.board_size}x${state.game.board_size}</span>` : ""}
        </div>

        <div class="stack invite-block">
          <div class="button-row">
            <button class="btn btn-primary btn-invite" data-action="open-invite-sheet">Spelers uitnodigen</button>
            ${renderInstallButton()}
          </div>
          <div class="invite-code-card">
            <span class="input-label">Spelcode</span>
            <strong>${escapeHtml(state.game.code)}</strong>
          </div>
        </div>

        <div class="meta-row">
          <button class="btn btn-secondary" data-action="copy-link">${isLocalFileMode() ? "Kopieer code" : "Kopieer link"}</button>
          ${isHost() && hasHostToolsSupport() ? '<button class="btn btn-outline" data-action="rename-game">Naam aanpassen</button>' : ""}
          <button class="btn btn-outline" data-action="leave-game">Verlaat spel</button>
        </div>

        ${
          isLocalFileMode()
            ? `
                <div class="notice">
                  Deel voorlopig alleen code ${escapeHtml(state.game.code)}.
                </div>
              `
            : ""
        }
      </article>

      ${renderLobbyPlayers()}
      ${renderHostPanel(scoreRows, activeCount)}

      <article class="panel panel-pad stack">
        <div>
          <p class="eyebrow">Spelstatus</p>
          <h3>Kerncijfers</h3>
        </div>

        <div class="compact-stats">
          <span class="chip chip-muted">${state.players.length} spelers</span>
          <span class="chip chip-muted">${activeCount} gebeurtenissen</span>
          <span class="chip chip-muted">${state.events.filter((event) => event.triggered).length} gebeurd</span>
          ${requiredCount ? `<span class="chip chip-muted">Kaart ${state.game.board_size}x${state.game.board_size}</span>` : ""}
        </div>
      </article>
    </section>
  `;
}

function renderInviteSheet() {
  const shareUrl = getShareUrl();

  return `
    <section class="sheet-backdrop" data-action="close-invite-sheet">
      <article class="invite-sheet panel panel-pad stack" role="dialog" aria-modal="true" aria-label="Spelers uitnodigen">
        <div class="title-row">
          <div>
            <p class="eyebrow">Uitnodigen</p>
            <h3>Nodig uit</h3>
          </div>
          <button class="btn btn-small btn-outline" data-action="close-invite-sheet">Sluiten</button>
        </div>

        <div class="invite-code-card is-large">
          <span class="input-label">Spelcode</span>
          <strong>${escapeHtml(state.game.code)}</strong>
        </div>

        <div class="notice">
          ${isLocalFileMode() ? "Deel de spelcode." : escapeHtml(shareUrl)}
        </div>

        <div class="stack">
          <button class="btn btn-primary btn-invite" data-action="share-invite">Deel uitnodiging</button>
          <button class="btn btn-secondary" data-action="copy-link">${isLocalFileMode() ? "Kopieer spelcode" : "Kopieer uitnodigingslink"}</button>
        </div>
      </article>
    </section>
  `;
}

function renderLobbyPlayers() {
  return `
    <article class="panel panel-pad stack">
      <div>
        <p class="eyebrow">Spelers</p>
        <h3>Spelers</h3>
      </div>

      <ul class="roster-list">
        ${state.players
          .map((player) => {
            const isCurrentPlayer = player.id === state.session.playerId;
            const isPlayerHost = player.id === state.game.host_player_id;

            return `
              <li class="roster-item">
                <div>
                  <p class="score-name">${escapeHtml(player.name)}</p>
                  <p class="score-meta">${isCurrentPlayer ? "Jij" : "Speler"}</p>
                </div>
                <div class="meta-row">
                  ${isCurrentPlayer ? '<span class="chip chip-accent">Jij</span>' : ""}
                  ${isPlayerHost ? '<span class="chip chip-teal">Host</span>' : ""}
                  ${
                    hasHostToolsSupport() && canHostManagePlayers() && !isCurrentPlayer && !isPlayerHost
                      ? `<button class="btn btn-small btn-danger" data-action="kick-player" data-player-id="${player.id}">Verwijder</button>`
                      : ""
                  }
                </div>
              </li>
            `;
          })
          .join("")}
      </ul>
    </article>
  `;
}

function renderAwardsPanel() {
  const lineAwards = getAwardsByType("line");
  const fullCardAwards = getAwardsByType("full_card");

  return `
    <section class="split">
      ${renderAwardColumn("Eerste rij", "", lineAwards)}
      ${renderAwardColumn("Volle kaart", "", fullCardAwards)}
    </section>
  `;
}

function renderAwardColumn(title, description, awards) {
  return `
    <article class="panel panel-pad stack">
      <div>
        <p class="eyebrow">Ranglijst</p>
        <h3>${escapeHtml(title)}</h3>
        ${description ? `<p class="subtitle">${escapeHtml(description)}</p>` : ""}
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
          : '<div class="notice">Nog leeg.</div>'
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

        <p class="helper">3x3: 9 nodig. 4x4: 16 nodig.</p>
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
            <h3>Start spel</h3>
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
    </section>
  `;
}

function renderBuildCardsStage() {
  const requiredCount = getRequiredCount();
  const selectionCount = state.draftSelectionIds.length;

  return `
    <section class="stack">
      <article class="panel panel-pad stack">
        <div class="title-row">
          <div>
            <p class="eyebrow">Kaart kiezen</p>
            <h3>Jouw kaart van ${state.game.board_size}x${state.game.board_size}</h3>
            <p class="subtitle compact-copy">Kies ${requiredCount}. Sleep om te ordenen.</p>
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
          ${state.draftDirty ? '<span class="chip chip-accent">Niet opgeslagen</span>' : '<span class="chip chip-muted">Opgeslagen</span>'}
        </div>
      </article>
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
  const activeEvents = getFilteredEvents();
  const requiredCount = getRequiredCount();

  return `
    <article class="panel panel-pad stack">
      <div>
        <p class="eyebrow">Beschikbare gebeurtenissen</p>
        <h3>Kies je kaartvakken</h3>
      </div>

      ${renderEventSearchInput("Zoek in gebeurtenissen voor je kaart")}

      ${
        activeEvents.length
          ? `<ul class="selection-list">${activeEvents.map((event) => renderSelectionItem(event, requiredCount)).join("")}</ul>`
          : '<div class="notice">Nog leeg.</div>'
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
          <h3>Gebeurtenissen</h3>
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
                    value="${escapeHtml(state.eventDraftText)}"
                    ${state.isMutating ? "disabled" : ""}
                    required
                  >
                </label>

                <div class="button-row">
                  <button class="btn btn-primary" type="submit" ${state.isMutating ? "disabled" : ""}>Toevoegen</button>
                </div>
              </form>
            `
          : ""
      }

      ${
        activeEvents.length
          ? `<ul class="event-list">${activeEvents.map((event) => renderEventItem(event)).join("")}</ul>`
          : '<div class="notice">Nog geen gebeurtenissen.</div>'
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
  const canUndo = event.triggered && event.triggered_by_player_id === state.session.playerId;

  return `
    <li class="event-item ${event.triggered ? "is-triggered" : ""}">
      <div class="event-head">
        <div>
          <p class="event-text">${escapeHtml(event.text)}</p>
          <p class="event-meta">${escapeHtml(triggeredByText)}</p>
        </div>
        ${
          event.triggered
            ? canUndo
              ? `<button class="btn btn-small btn-outline" data-action="undo-event" data-event-id="${event.id}" ${state.isMutating ? "disabled" : ""}>Herstel</button>`
              : '<span class="chip chip-success">Gebeurd</span>'
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
        </div>
        <span class="chip ${checkedCount === requiredCount && requiredCount ? "chip-success" : "chip-accent"}">
          ${checkedCount}/${requiredCount} afgevinkt
        </span>
      </div>

      <div class="meta-row">
        ${myLineAward ? `<span class="chip chip-teal">Rij #${myLineAward.placement}</span>` : ""}
        ${myFullCardAward ? `<span class="chip chip-success">Volle kaart #${myFullCardAward.placement}</span>` : ""}
      </div>

      ${renderCardPreview(myEntries.map((entry) => entry.event_id), false)}
    </article>
  `;
}

function renderBingoBanner() {
  return `
    <section class="bingo-banner">
      <p class="eyebrow">Bingo</p>
      <p class="bingo-word">VOLLE KAART</p>
    </section>
  `;
}

function renderEventSearchInput(placeholder) {
  return `
    <label class="input-group">
      <span class="input-label">Zoeken</span>
      <input
        class="text-input"
        type="search"
        data-input="event-search"
        placeholder="${escapeHtml(placeholder)}"
        value="${escapeHtml(state.eventSearch)}"
      >
    </label>
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
    const canTriggerFromCard = !isDraft && state.game?.status === "playing" && event && !checked && !event.triggered;
    const canUndoFromCard =
      !isDraft &&
      ["playing", "finished"].includes(state.game?.status) &&
      event &&
      checked &&
      event.triggered &&
      event.triggered_by_player_id === state.session.playerId;
    const hit = entry && state.recentEntryIds.includes(entry.id);
    const isDragSource = isDraft && state.drag.active && state.drag.sourceIndex === index;
    const isDragTarget = isDraft && state.drag.active && state.drag.overIndex === index && state.drag.sourceIndex !== index;

    const classes = [
      "board-cell",
      event ? "" : "is-empty",
      checked ? "is-checked" : "",
      hit ? "is-hit" : "",
      isDraft && event ? "is-draft" : "",
      canTriggerFromCard || canUndoFromCard ? "is-actionable" : "",
      isDragSource ? "is-drag-source" : "",
      isDragTarget ? "is-drag-target" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return `
      <button
        class="${classes}"
        type="button"
        ${isDraft ? `data-draft-slot="${index}" data-has-event="${event ? "true" : "false"}" data-draft-label="${escapeHtml(event?.text ?? "")}"` : ""}
        ${canTriggerFromCard ? `data-action="trigger-event" data-event-id="${event.id}"` : ""}
        ${canUndoFromCard ? `data-action="undo-event" data-event-id="${event.id}"` : ""}
        ${canTriggerFromCard ? `aria-label="Markeer ${escapeHtml(event.text)} als gebeurd"` : ""}
        ${canUndoFromCard ? `aria-label="Herstel ${escapeHtml(event.text)}"` : ""}
        ${!event && !isDraft ? "disabled" : ""}
      >
        ${checked && !isDraft ? '<span class="board-check" aria-hidden="true"></span>' : ""}
        <span class="board-label">${escapeHtml(event?.text ?? "Leeg vak")}</span>
      </button>
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
          <h3>Stand</h3>
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
          : '<div class="notice">Nog leeg.</div>'
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
    state.showSettingsSheet = false;
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
    const gameName = String(formData.get("gameName") || "").trim();
    await createGame(name, gameName);
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

  if (action === "switch-tab") {
    state.activeTab = actionTarget.dataset.tab || "kaart";
    render();
    return;
  }

  if (action === "toggle-game-info") {
    state.gameInfoCollapsed = !state.gameInfoCollapsed;
    render();
    return;
  }

  if (action === "open-invite-sheet") {
    state.showInviteSheet = true;
    render();
    return;
  }

  if (action === "open-settings-sheet") {
    state.showSettingsSheet = true;
    render();
    return;
  }

  if (action === "install-app") {
    await promptInstall();
    return;
  }

  if (action === "close-invite-sheet") {
    if (event.target === actionTarget || actionTarget.dataset.action === "close-invite-sheet") {
      state.showInviteSheet = false;
      render();
    }
    return;
  }

  if (action === "close-settings-sheet") {
    if (event.target === actionTarget || actionTarget.dataset.action === "close-settings-sheet") {
      state.showSettingsSheet = false;
      render();
    }
    return;
  }

  if (action === "leave-game") {
    if (!window.confirm("Weet je zeker dat je deze lokale sessie wilt verlaten?")) {
      return;
    }

    clearSession({ keepUrlCode: false });
    render();
    return;
  }

  if (action === "rename-game") {
    const nextName = window.prompt("Nieuwe spelnaam:", state.game?.name || "");
    if (nextName === null) {
      return;
    }

    await updateGameName(nextName);
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
      state.showInviteSheet = false;
      render();
    } catch (error) {
      pushToast("Kopieren lukt niet op dit apparaat.", "error");
    }
    return;
  }

  if (action === "share-invite") {
    await shareInvite();
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

  if (action === "undo-event") {
    const undoEventRecord = getActiveEvents().find((item) => item.id === eventId);
    if (!undoEventRecord || undoEventRecord.triggered_by_player_id !== state.session.playerId) {
      pushToast("Alleen je eigen markering kun je herstellen.", "error");
      return;
    }

    if (!window.confirm(`Herstel "${undoEventRecord.text}" als per ongeluk gemarkeerd?`)) {
      return;
    }

    await untriggerEvent(eventId);
    return;
  }

  if (action === "toggle-card-event") {
    toggleCardEvent(eventId);
    return;
  }

  if (action === "kick-player") {
    const targetPlayerId = actionTarget.dataset.playerId || "";
    const targetPlayer = state.players.find((player) => player.id === targetPlayerId);

    if (!targetPlayer) {
      pushToast("Speler niet gevonden.", "error");
      return;
    }

    if (!window.confirm(`${targetPlayer.name} uit dit spel verwijderen?`)) {
      return;
    }

    await kickPlayer(targetPlayerId);
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

function handleInput(event) {
  const inputName = event.target?.dataset?.input;

  if (inputName === "event-search") {
    state.eventSearch = String(event.target.value || "");
    render();
    return;
  }

  if (
    event.target?.name === "eventText" &&
    event.target?.form?.dataset?.form === "add-event"
  ) {
    state.eventDraftText = String(event.target.value || "");
  }
}

async function shareInvite() {
  const shareUrl = getShareUrl();

  try {
    if (navigator.share && !isLocalFileMode()) {
      await navigator.share({
        title: `Party Bingo ${state.game.code}`,
        text: `Speel mee in Party Bingo. Code: ${state.game.code}`,
        url: shareUrl,
      });
      state.showInviteSheet = false;
      render();
      pushToast("Uitnodiging gedeeld.", "success");
      return;
    }

    await navigator.clipboard.writeText(isLocalFileMode() ? state.game.code : shareUrl);
    state.showInviteSheet = false;
    render();
    pushToast(isLocalFileMode() ? "Spelcode gekopieerd." : "Uitnodigingslink gekopieerd.", "success");
  } catch (error) {
    pushToast("Delen of kopieren lukt niet op dit apparaat.", "error");
  }
}

async function promptInstall() {
  if (state.isStandalone) {
    pushToast("De app staat al op je startscherm.", "info");
    return;
  }

  if (!deferredInstallPrompt) {
    pushToast("Gebruik Toevoegen aan startscherm in je browsermenu.", "info");
    return;
  }

  try {
    deferredInstallPrompt.prompt();
    const choiceResult = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    state.canInstall = false;
    render();

    if (choiceResult?.outcome === "accepted") {
      pushToast("Installatie gestart.", "success");
    }
  } catch (error) {
    pushToast("Installeren lukt nu even niet.", "error");
  }
}

async function createGame(name, gameName = "") {
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
    if (gameName) {
      try {
        const renameResult = await state.supabase.rpc("update_game_name", {
          p_game_id: state.session.gameId,
          p_player_id: state.session.playerId,
          p_session_token: state.session.sessionToken,
          p_name: gameName,
        });

        if (renameResult.error) {
          throw renameResult.error;
        }

        await loadSnapshot();
      } catch (error) {
        if (!isMissingHostToolsSupport(error)) {
          throw error;
        }
      }
    }
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

    state.eventDraftText = "";
    pushToast("Gebeurtenis toegevoegd.", "success");
    await loadSnapshot();
  });
}

async function updateGameName(name, { silent = false } = {}) {
  await runMutation(async () => {
    const { error } = await state.supabase.rpc("update_game_name", {
      p_game_id: state.session.gameId,
      p_player_id: state.session.playerId,
      p_session_token: state.session.sessionToken,
      p_name: name,
    });

    if (error) {
      if (isMissingHostToolsSupport(error)) {
        pushToast("Voer eerst de host-tools SQL-migratie uit.", "info");
        return;
      }
      throw error;
    }

    await loadSnapshot();

    if (!silent) {
      pushToast("Spelnaam aangepast.", "success");
    }
  });
}

async function kickPlayer(targetPlayerId) {
  await runMutation(async () => {
    const { error } = await state.supabase.rpc("kick_player_from_game", {
      p_game_id: state.session.gameId,
      p_player_id: state.session.playerId,
      p_session_token: state.session.sessionToken,
      p_target_player_id: targetPlayerId,
    });

    if (error) {
      if (isMissingHostToolsSupport(error)) {
        pushToast("Voer eerst de host-tools SQL-migratie uit.", "info");
        return;
      }
      throw error;
    }

    await loadSnapshot();
    pushToast("Speler verwijderd.", "success");
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

async function untriggerEvent(eventId) {
  await runMutation(async () => {
    const { error } = await state.supabase.rpc("untrigger_event", {
      p_game_id: state.session.gameId,
      p_event_id: eventId,
      p_player_id: state.session.playerId,
      p_session_token: state.session.sessionToken,
    });

    if (error) {
      throw error;
    }

    await loadSnapshot();
    pushToast("Gebeurtenis hersteld.", "success");
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

function isMissingHostToolsSupport(error) {
  const message = String(error?.message || error?.details || "");
  const code = String(error?.code || "");

  return (
    code === "42883" ||
    message.includes("update_game_name") ||
    message.includes("kick_player_from_game") ||
    message.includes("column games.name does not exist")
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
