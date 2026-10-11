import { describe, expect, test } from "bun:test";
import { convertChannels, formatFeeds, normalizeInput, parseInput } from "../src/index.ts";

const ID = "UCBLCvUUCiSqBCEc-TqZ9rGw";
const FEED = `https://www.youtube.com/feeds/videos.xml?channel_id=${ID}`;

describe("input", () => {
  test("accepts a UTF-8 BOM, mixed line endings, comments, and blank lines without losing line numbers", () => {
    expect(parseInput(`\uFEFF# comment\r\n\r\n ${ID} \r@juanrallo\n`)).toEqual([
      { value: ID, line: 3 }, { value: "@juanrallo", line: 4 },
    ]);
  });

  test("normalizes a handle and its channel tabs to the same lookup", () => {
    const input = normalizeInput("@JuanRallo");
    expect(normalizeInput("https://m.youtube.com/@JuanRallo/videos?view=0#top")).toEqual(input);
    expect(normalizeInput("www.youtube.com/@JuanRallo")).toEqual(input);
    expect(input.key).toBe("@juanrallo");
  });

  test("raw IDs and /channel URLs carry the ID for offline conversion", () => {
    expect(normalizeInput(`https://www.youtube.com/channel/${ID}/shorts`)).toEqual(normalizeInput(ID));
    expect(normalizeInput(ID).channelId).toBe(ID);
  });

  test("supports Unicode handles and legacy channel URLs", () => {
    expect(normalizeInput("https://youtube.com/@caf%C3%A9").label).toBe("@café");
    expect(normalizeInput("https://youtube.com/user/Google/videos").url).toBe("https://www.youtube.com/user/Google");
    expect(normalizeInput("https://youtube.com/c/SomeChannel").key).toBe("c/SomeChannel");
  });

  test.each([
    "UCtoo-short", "@", "@bad name", `https://youtube.com/channel/${ID.slice(1)}`,
    "https://youtube.com/watch?v=123", "https://youtu.be/123", "https://youtube.com/playlist?list=123",
    "https://youtube.com.evil.example/@name", "https://example.com/@name",
    "https://user:password@youtube.com/@name", "ftp://youtube.com/@name",
    "https://youtube.com:444/@name", "https://youtube.com/@name%2Fother",
    "https://youtube.com/@name/unrecognized", "https://youtube.com/@%ZZ",
  ])("rejects malformed IDs and unsupported URLs: %s", value => {
    expect(() => normalizeInput(value)).toThrow();
  });
});

describe("output", () => {
  test("writes one canonical feed URL per line", async () => {
    const result = await convertChannels(`${ID}\n`);
    expect(formatFeeds(result.feeds)).toBe(`${FEED}\n`);
  });

  test("writes OPML 2.0 with escaped attributes and Unicode titles", async () => {
    const { feeds } = await convertChannels(ID);
    feeds[0]!.title = `Café & <news> "quoted" 'title'\nnext\u0000\uD800`;
    const output = formatFeeds(feeds, "opml");
    expect(output).toContain('<opml version="2.0">');
    expect(output).toContain(`xmlUrl="${FEED}"`);
    expect(output).toContain(`htmlUrl="https://www.youtube.com/channel/${ID}"`);
    expect(output).toContain("Café &amp; &lt;news&gt; &quot;quoted&quot; &apos;title&apos;&#10;next�");
    expect(output).not.toContain("\u0000");
    expect(output.match(/<outline /g)).toHaveLength(1);
  });

  test("handles empty exports", () => {
    expect(formatFeeds([])).toBe("");
    expect(formatFeeds([], "opml")).toContain("  <body>\n  </body>");
  });

  test("groups every feed inside one named category outline for Miniflux", async () => {
    const { feeds } = await convertChannels(`${ID}\nUC_x5XG1OV2P6uZZ5FSM9Ttw`);
    const output = formatFeeds(feeds, "opml", { category: "  YouTube & Tech  " });
    expect(output).toContain('    <outline text="YouTube &amp; Tech" title="YouTube &amp; Tech">\n      <outline type="rss"');
    expect(output.match(/      <outline type="rss"/g)).toHaveLength(2);
    expect(output.match(/<outline /g)).toHaveLength(3);
    expect(output).toContain("    </outline>\n  </body>");
  });

  test("escapes special characters in category names", async () => {
    const { feeds } = await convertChannels(ID);
    const output = formatFeeds(feeds, "opml", { category: 'Café <videos> & "news"' });
    expect(output).toContain('text="Café &lt;videos&gt; &amp; &quot;news&quot;"');
    expect(output).toContain('title="Café &lt;videos&gt; &amp; &quot;news&quot;"');
  });

  test("rejects blank category names and categories in plain text output", () => {
    expect(() => formatFeeds([], "opml", { category: "" })).toThrow("non-empty");
    expect(() => formatFeeds([], "opml", { category: " \n " })).toThrow("non-empty");
    expect(() => formatFeeds([], "text", { category: "YouTube" })).toThrow("requires OPML");
  });
});
