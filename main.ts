import { Command } from "https://deno.land/x/cliffy@v1.0.0-rc.4/command/mod.ts";
import { Hono } from "npm:hono";

async function getRSSFeedFast(url: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Error: Failed to fetch channel. Status: ${res.status}`);
      return null;
    }
    const html = await res.text();

    const match = html.match(
      /<link[^>]+rel="alternate"[^>]+type="application\/rss\+xml"[^>]+href="([^"]+)"/i
    );

    return match ? match[1] : null;
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(`Error fetching RSS feed (fast): ${err.message}`);
    }
    return null;
  }
}

async function getRSSFeedBrowser(url: string) {
  try {
    const playwright = await import("npm:playwright");
    const chromium = playwright.chromium;
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const rssLink = page.locator(
        'link[rel="alternate"][type="application/rss+xml"]'
      ).first();
      const href = await rssLink.getAttribute("href");
      return href || null;
    } finally {
      await browser.close();
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(`Error fetching RSS feed (browser): ${err.message}`);
    }
    return null;
  }
}

function startAPIServer(port: number, useBrowser: boolean) {
  const app = new Hono();

  app.get("/rss", async (c) => {
    const url = c.req.query("url");
    if (!url) {
      return c.json({ error: "Missing required query parameter: url" }, 400);
    }

    const rssUrl = useBrowser
      ? await getRSSFeedBrowser(url)
      : await getRSSFeedFast(url);

    if (!rssUrl) {
      return c.json({ error: "No RSS link found for the given URL." }, 404);
    }

    return c.json({ rss: rssUrl });
  });

  console.log(`API server running on http://localhost:${port}`);
  console.log(`Endpoint: GET http://localhost:${port}/rss?url=<youtube-channel-url>`);
  Deno.serve({ port }, app.fetch);
}

await new Command()
  .name("ytb2rss")
  .version("0.1.0")
  .description("Get the RSS feed URL for a YouTube channel")
  .arguments("[url:string]")
  .option("-b, --browser", "Use Playwright browser to extract (slower but more robust)")
  .option("-s, --serveapi", "Start an HTTP API server instead of running as a CLI tool")
  .option("-p, --port <port:number>", "Port for the API server (only used with --serveapi)", { default: 8000 })
  .action(async (options, url) => {
    if (options.serveapi) {
      startAPIServer(options.port, !!options.browser);
      return;
    }

    if (!url) {
      console.error("Error: A YouTube channel URL is required when not using --serveapi.");
      Deno.exit(1);
    }

    const rssUrl = options.browser
      ? await getRSSFeedBrowser(url)
      : await getRSSFeedFast(url);

    if (rssUrl) {
      console.log(rssUrl);
    } else {
      console.error("No RSS link found. Make sure the URL is a valid YouTube channel URL.");
      Deno.exit(1);
    }
  })
  .parse(Deno.args);
