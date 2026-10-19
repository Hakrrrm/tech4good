import { describe, expect, it } from "vitest";
import { createLeaderboardStore, LEADERBOARD_KEY, normalizePlayerName } from "../src/leaderboard.js";

function memoryStorage() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

const entry = (overrides = {}) => ({
  id: "session-1", name: "Alice", score: 100, pace: "gentle", durationSeconds: 30,
  mode: "camera", endedAt: 1000, ...overrides,
});

describe("device-local leaderboard", () => {
  it("normalizes optional names, strips controls, and limits names without splitting emoji", () => {
    expect(normalizePlayerName(" \t\n ")).toBe("Guest");
    expect(normalizePlayerName("  Alice   Tan\u202e\u0000 ")).toBe("Alice Tan");
    expect(normalizePlayerName("🌼".repeat(30))).toBe("🌼".repeat(24));
    expect(normalizePlayerName("张 三")).toBe("张 三");
  });

  it("persists across fresh store instances, including zero scores and Guest sessions", () => {
    const storage = memoryStorage();
    createLeaderboardStore(() => storage).save(entry({ name: "", score: 0 }));
    const board = createLeaderboardStore(() => storage).list("gentle", 30);
    expect(board.persistent).toBe(true);
    expect(board.entries).toEqual([entry({ name: "Guest", score: 0 })]);
  });

  it("keeps the highest five per pace and duration without mixing categories", () => {
    const storage = memoryStorage();
    const store = createLeaderboardStore(() => storage);
    for (const pace of ["gentle", "steady", "lively"]) {
      for (const durationSeconds of [20, 30, 60]) {
        for (let score = 0; score < 8; score++) {
          store.save(entry({ id: `${pace}:${durationSeconds}:${score}`, pace, durationSeconds, score }));
        }
      }
    }
    expect(store.list("gentle", 30).entries.map((row) => row.score)).toEqual([7, 6, 5, 4, 3]);
    expect(store.list("lively", 60).entries).toHaveLength(5);
    expect(JSON.parse(storage.getItem(LEADERBOARD_KEY)).entries).toHaveLength(45);
  });

  it("ranks ties by the earlier session and cannot duplicate the same session", () => {
    const storage = memoryStorage();
    const store = createLeaderboardStore(() => storage);
    store.save(entry({ id: "later", endedAt: 2000 }));
    store.save(entry({ id: "earlier", endedAt: 1000 }));
    store.save(entry({ id: "earlier", endedAt: 1000 }));
    expect(store.list("gentle", 30).entries.map((row) => row.id)).toEqual(["earlier", "later"]);
  });

  it.each(["broken json", JSON.stringify({ version: 9, entries: [entry()] }), JSON.stringify({ version: 1, entries: {} })])(
    "recovers from malformed or unsupported stored data: %s", (raw) => {
      const storage = memoryStorage();
      storage.setItem(LEADERBOARD_KEY, raw);
      const store = createLeaderboardStore(() => storage);
      expect(store.list("gentle", 30).entries).toEqual([]);
      expect(store.save(entry()).entries).toHaveLength(1);
    },
  );

  it("ignores invalid stored rows and rejects invalid new scores", () => {
    const storage = memoryStorage();
    storage.setItem(LEADERBOARD_KEY, JSON.stringify({ version: 1, entries: [
      null, entry({ score: -1 }), entry({ score: 1.5 }), entry({ durationSeconds: 300 }),
      entry({ mode: "unknown" }), entry({ name: null }), entry(),
    ] }));
    const store = createLeaderboardStore(() => storage);
    expect(store.list("gentle", 30).entries).toEqual([entry()]);
    expect(() => store.save(entry({ score: Infinity }))).toThrow(TypeError);
  });

  it("continues in memory if localStorage access is denied", () => {
    const store = createLeaderboardStore(() => { throw new Error("SecurityError"); });
    expect(store.save(entry()).persistent).toBe(false);
    expect(store.list("gentle", 30)).toEqual({ entries: [entry()], persistent: false });
  });

  it("retains temporary scores after quota failure and retries them on the next save", () => {
    const storage = memoryStorage();
    const store = createLeaderboardStore(() => storage);
    const setItem = storage.setItem;
    storage.setItem = () => { throw new Error("QuotaExceededError"); };
    expect(store.save(entry()).persistent).toBe(false);
    expect(store.list("gentle", 30)).toEqual({ entries: [entry()], persistent: false });
    storage.setItem = setItem;
    expect(store.save(entry({ id: "second", score: 200 })).persistent).toBe(true);
    expect(createLeaderboardStore(() => storage).list("gentle", 30).entries).toHaveLength(2);
  });

  it("reads scores saved by another store before merging a new session", () => {
    const storage = memoryStorage();
    const first = createLeaderboardStore(() => storage);
    const second = createLeaderboardStore(() => storage);
    first.list("gentle", 30);
    second.save(entry());
    first.save(entry({ id: "second" }));
    expect(second.list("gentle", 30).entries).toHaveLength(2);
  });
});
