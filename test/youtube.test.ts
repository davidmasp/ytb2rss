import { describe, expect, test } from "bun:test";
import { createChannelResolver, extractChannel, normalizeInput } from "../src/index.ts";

const ID = "UCBLCvUUCiSqBCEc-TqZ9rGw";
const OTHER = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
const PAGE_URL = "https://www.youtube.com/@juanrallo";
const INPUT = normalizeInput("@juanrallo");
const PAGE = await Bun.file(new URL("./fixtures/channel-page.html", import.meta.url)).text();
const METADATA = await Bun.file(new URL("./fixtures/channel-metadata.html", import.meta.url)).text();
const noSleep = async () => {};

describe("HTML extraction", () => {
  test("extracts the feed advertised by the page, including relative URLs and shuffled attributes", () => {
    expect(extractChannel(PAGE, PAGE_URL)).toEqual({ channelId: ID, title: "Juan Ramón Rallo" });
  });

  test("uses channel-specific metadata rather than a recommendation's ID", () => {
    expect(extractChannel(METADATA, PAGE_URL)).toEqual({ channelId: ID, title: 'A "quoted" {channel} & café' });
  });

  test("decodes HTML entities in titles so OPML readers receive the original channel name", () => {
    const html = `<meta property="og:title" content="Caf&#233; &amp; Tea &copy;"><meta itemprop="channelId" content="${ID}">`;
    expect(extractChannel(html, PAGE_URL).title).toBe("Café & Tea ©");
    expect(extractChannel(`<title>Tea &amp; Coffee - YouTube</title><meta itemprop="channelId" content="${ID}">`, PAGE_URL).title)
      .toBe("Tea & Coffee");
  });

  test("uses canonical channel links and itemprop metadata as further fallbacks", () => {
    expect(extractChannel(`<link rel="canonical" href="/channel/${ID}"><title>Example - YouTube</title>`, PAGE_URL))
      .toEqual({ channelId: ID, title: "Example" });
    expect(extractChannel(`<meta itemprop="channelId" content="${ID}">`, PAGE_URL).channelId).toBe(ID);
  });

  test("ignores invalid and foreign feed links", () => {
    expect(() => extractChannel(`<link type="application/rss+xml" href="https://evil.example/feeds/videos.xml?channel_id=${OTHER}">`, PAGE_URL))
      .toThrow("No channel feed");
    expect(() => extractChannel('<link type="application/rss+xml" href="/feeds/videos.xml?channel_id=UCshort">', PAGE_URL))
      .toThrow("No channel feed");
  });

  test("does not execute embedded JavaScript or treat arbitrary IDs as channel metadata", () => {
    expect(() => extractChannel(`<script>throw new Error("executed");</script><div>${ID}</div>`, PAGE_URL)).toThrow("No channel feed");
    expect(() => extractChannel('<script>{"channelMetadataRenderer": {broken JSON}</script>', PAGE_URL)).toThrow("No channel feed");
  });

  test("reports consent pages explicitly", () => {
    expect(() => extractChannel("<title>Before you continue to YouTube</title>", PAGE_URL)).toThrow("consent or blocking page");
  });

  test("does not mistake a real channel named Sorry for a blocking page", () => {
    const html = `<title>Sorry - YouTube</title><link type="application/rss+xml" href="/feeds/videos.xml?channel_id=${ID}">`;
    expect(extractChannel(html, PAGE_URL)).toEqual({ channelId: ID, title: "Sorry" });
  });
});

describe("HTTP lookup", () => {
  test("makes no request for raw channel IDs", async () => {
    const resolve = createChannelResolver({ fetch: async () => { throw new Error("Unexpected HTTP request"); } });
    expect((await resolve(normalizeInput(ID))).channelId).toBe(ID);
  });

  test("retries server errors with backoff and preserves pacing", async () => {
    let requests = 0;
    const waits: number[] = [];
    const resolve = createChannelResolver({
      delayMs: 100, sleep: async ms => { waits.push(ms); },
      fetch: async (_url, init) => {
        expect(init.redirect).toBe("manual");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return ++requests < 3 ? new Response("", { status: 503 }) : new Response(PAGE);
      },
    });
    expect((await resolve(INPUT)).channelId).toBe(ID);
    expect(requests).toBe(3);
    expect(waits).toEqual([500, 100, 1000, 100]);
  });

  test("uses Retry-After for rate limiting", async () => {
    let requests = 0;
    const waits: number[] = [];
    const resolve = createChannelResolver({
      delayMs: 0, sleep: async ms => { waits.push(ms); },
      fetch: async () => ++requests === 1
        ? new Response("", { status: 429, headers: { "Retry-After": "2" } }) : new Response(PAGE),
    });
    await resolve(INPUT);
    expect(waits).toEqual([2000]);
  });

  test("bounds repeated failures to the configured number of retries", async () => {
    let requests = 0;
    const resolve = createChannelResolver({ retries: 1, delayMs: 0, sleep: noSleep,
      fetch: async () => { requests++; throw new Error("Connection reset"); },
    });
    await expect(resolve(INPUT)).rejects.toThrow("Connection reset");
    expect(requests).toBe(2);
  });

  test.each([403, 404])("does not retry permanent HTTP %i failures", async status => {
    let requests = 0;
    const resolve = createChannelResolver({ delayMs: 0, sleep: noSleep,
      fetch: async () => { requests++; return new Response("", { status }); },
    });
    await expect(resolve(INPUT)).rejects.toThrow(`HTTP ${status}`);
    expect(requests).toBe(1);
  });

  test("does not retry a consent page or missing metadata", async () => {
    let requests = 0;
    const resolve = createChannelResolver({ delayMs: 0, sleep: noSleep,
      fetch: async () => { requests++; return new Response("<title>Before you continue to YouTube</title>"); },
    });
    await expect(resolve(INPUT)).rejects.toThrow("consent or blocking page");
    expect(requests).toBe(1);
  });

  test("follows YouTube redirects but does not fetch consent or foreign hosts", async () => {
    const urls: string[] = [];
    const resolve = createChannelResolver({ delayMs: 0, fetch: async url => {
      urls.push(url);
      return urls.length === 1 ? new Response("", { status: 302, headers: { location: `/channel/${ID}` } }) : new Response(PAGE);
    } });
    await resolve(INPUT);
    expect(urls).toEqual([PAGE_URL, `https://www.youtube.com/channel/${ID}`]);

    const blocked = createChannelResolver({ delayMs: 0, fetch: async () =>
      new Response("", { status: 302, headers: { location: "https://consent.youtube.com/" } }),
    });
    await expect(blocked(INPUT)).rejects.toThrow("consent page or an unsupported host");
  });

  test("bounds redirect loops", async () => {
    let requests = 0;
    const resolve = createChannelResolver({ delayMs: 0, fetch: async () => {
      requests++;
      return new Response("", { status: 302, headers: { location: PAGE_URL } });
    } });
    await expect(resolve(INPUT)).rejects.toThrow("too many redirects");
    expect(requests).toBe(6);
  });

  test("times out even when fetching headers never completes", async () => {
    let signal: AbortSignal | undefined;
    const resolve = createChannelResolver({ timeoutMs: 20, retries: 0, delayMs: 0,
      fetch: async (_url, init) => { signal = init.signal!; return await new Promise<Response>(() => {}); },
    });
    await expect(resolve(INPUT)).rejects.toThrow("timed out");
    expect(signal?.aborted).toBe(true);
  });

  test("the timeout also covers a stalled response body and cancels it", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const resolve = createChannelResolver({ timeoutMs: 20, retries: 0, delayMs: 0,
      fetch: async () => new Response(stream),
    });
    await expect(resolve(INPUT)).rejects.toThrow("timed out");
    expect(cancelled).toBe(true);
  });

  test("rejects oversized channel pages without retrying", async () => {
    let requests = 0;
    const resolve = createChannelResolver({ delayMs: 0, fetch: async () => {
      requests++;
      return new Response("x".repeat(5 * 1024 * 1024 + 1));
    } });
    await expect(resolve(INPUT)).rejects.toThrow("size limit");
    expect(requests).toBe(1);
  });
});
