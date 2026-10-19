export const LEADERBOARD_KEY = "gentle-catch.leaderboard.v1";
export const LEADERBOARD_LIMIT = 5;
export const PLAYER_NAME_LIMIT = 24;

const paces = new Set(["gentle", "steady", "lively"]);
const durations = new Set([20, 30, 60]);

export function normalizePlayerName(value) {
  const name = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(name).slice(0, PLAYER_NAME_LIMIT).join("") || "Guest";
}

function validEntry(entry) {
  return entry && typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 100
    && typeof entry.name === "string"
    && Number.isSafeInteger(entry.score) && entry.score >= 0
    && paces.has(entry.pace) && durations.has(entry.durationSeconds)
    && ["camera", "keyboard"].includes(entry.mode)
    && Number.isSafeInteger(entry.endedAt) && entry.endedAt >= 0;
}

function rankEntries(entries) {
  const seen = new Set();
  const counts = new Map();
  return entries.filter(validEntry)
    .map((entry) => ({
      id: entry.id, name: normalizePlayerName(entry.name), score: entry.score,
      pace: entry.pace, durationSeconds: entry.durationSeconds, mode: entry.mode, endedAt: entry.endedAt,
    }))
    .sort((a, b) => b.score - a.score || a.endedAt - b.endedAt || a.id.localeCompare(b.id))
    .filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      const group = `${entry.pace}:${entry.durationSeconds}`;
      const count = counts.get(group) || 0;
      counts.set(group, count + 1);
      return count < LEADERBOARD_LIMIT;
    });
}

// Storage is read only when displaying/saving a board, never in the game loop.
// If browser storage is blocked or full, play continues with an in-memory board.
export function createLeaderboardStore(getStorage = () => window.localStorage) {
  let cached = [];
  let unsaved = [];
  let persistent = true;

  function load() {
    try {
      const raw = getStorage().getItem(LEADERBOARD_KEY);
      let data;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
      const stored = data?.version === 1 && Array.isArray(data.entries) ? data.entries : [];
      cached = rankEntries([...stored, ...unsaved]);
      persistent = unsaved.length === 0;
    } catch {
      persistent = false;
    }
    return cached;
  }

  return {
    list(pace, durationSeconds) {
      return { entries: load().filter((entry) => entry.pace === pace && entry.durationSeconds === durationSeconds), persistent };
    },
    save(entry) {
      if (!validEntry(entry)) throw new TypeError("Invalid leaderboard entry");
      const entries = rankEntries([...load(), entry]);
      try {
        getStorage().setItem(LEADERBOARD_KEY, JSON.stringify({ version: 1, entries }));
        unsaved = [];
        persistent = true;
      } catch {
        unsaved = rankEntries([...unsaved, entry]);
        persistent = false;
      }
      cached = entries;
      return { entries: entries.filter((candidate) => candidate.pace === entry.pace && candidate.durationSeconds === entry.durationSeconds), persistent };
    },
  };
}
