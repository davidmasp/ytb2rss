import { describe, expect, test } from "bun:test";
import { CACHE_TTL_MS, convertChannels } from "../src/index.ts";
import type { CachedChannel } from "../src/index.ts";

const ID = "UCBLCvUUCiSqBCEc-TqZ9rGw";
const OTHER = "UC_x5XG1OV2P6uZZ5FSM9Ttw";

describe("batch conversion", () => {
  test("preserves order and deduplicates IDs, normalized handles, and aliases resolving to the same channel", async () => {
    const lookedUp: string[] = [];
    const result = await convertChannels(`${ID}\n${ID}\n@juanrallo\nhttps://youtube.com/@JuanRallo/videos\n${OTHER}`, {
      resolve: async input => { lookedUp.push(input.key); return { channelId: ID, title: "Rallo" }; },
    });
    expect(result.feeds.map(feed => feed.channelId)).toEqual([ID, OTHER]);
    expect(result.duplicates).toBe(3);
    expect(lookedUp).toEqual(["@juanrallo"]);
    expect(result.failures).toEqual([]);
  });

  test("exports good channels even when invalid inputs and lookups fail", async () => {
    const result = await convertChannels(`# comment\nnot-a-channel\n${ID}\n@missing\n${OTHER}`, {
      resolve: async () => { throw new Error("HTTP 404"); },
    });
    expect(result.feeds.map(feed => feed.channelId)).toEqual([ID, OTHER]);
    expect(result.total).toBe(4);
    expect(result.failures.map(failure => [failure.line, failure.input])).toEqual([[2, "not-a-channel"], [4, "@missing"]]);
    expect(result.failures[1]!.message).toBe("HTTP 404");
  });

  test("never calls the injected resolver for direct channel IDs", async () => {
    const result = await convertChannels(`${ID}\nhttps://youtube.com/channel/${OTHER}`, {
      resolve: async () => { throw new Error("Unexpected request"); },
    });
    expect(result.feeds).toHaveLength(2);
    expect(result.failures).toHaveLength(0);
  });

  test("rejects bad resolver results rather than exporting invalid feed URLs", async () => {
    const result = await convertChannels("@example", { resolve: async () => ({ channelId: "bad", title: "Bad" }) });
    expect(result.feeds).toHaveLength(0);
    expect(result.failures[0]!.message).toContain("invalid channel ID");
  });

  test("persists each successful resolution before starting the next one and reuses it on a rerun", async () => {
    const cache = new Map<string, CachedChannel>();
    const events: string[] = [];
    const result = await convertChannels("@first\n@second", {
      cache,
      resolve: async input => { events.push(`lookup:${input.key}`); return { channelId: input.key === "@first" ? ID : OTHER, title: input.label }; },
      onResolved: async key => { events.push(`save:${key}`); },
    });
    expect(events).toEqual(["lookup:@first", "save:@first", "lookup:@second", "save:@second"]);
    expect(result.feeds).toHaveLength(2);
    const rerun = await convertChannels("@first\n@second", {
      cache, resolve: async () => { throw new Error("Unexpected repeat lookup"); },
    });
    expect(rerun.failures).toEqual([]);
    expect(rerun.feeds).toHaveLength(2);
  });

  test("refreshes expired or future-dated alias mappings", async () => {
    const now = Date.now();
    const cache = new Map<string, CachedChannel>([
      ["@old", { channelId: OTHER, title: "Old", resolvedAt: now - CACHE_TTL_MS }],
      ["@future", { channelId: OTHER, title: "Future", resolvedAt: now + 1 }],
    ]);
    let requests = 0;
    await convertChannels("@old\n@future", { cache, now: () => now,
      resolve: async () => { requests++; return { channelId: ID, title: "Current" }; },
    });
    expect(requests).toBe(2);
    expect(cache.get("@old")!.channelId).toBe(ID);
  });

  test("does not cache failed lookups", async () => {
    const cache = new Map<string, CachedChannel>();
    await convertChannels("@missing", { cache, resolve: async () => { throw new Error("Blocked"); } });
    expect(cache.size).toBe(0);
  });

  test("propagates persistence failures rather than reporting them as channel failures", async () => {
    await expect(convertChannels("@example", {
      resolve: async () => ({ channelId: ID, title: "Example" }),
      onResolved: async () => { throw new Error("Disk full"); },
    })).rejects.toThrow("Disk full");
  });
});
