
import { chromium } from "npm:playwright";

async function extractRSS(url: string) {
  const browser = await chromium.launch({
    headless: false, // change to true if you don't need UI
  });

  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const rssLink = page.locator(
      'link[rel="alternate"][type="application/rss+xml"]'
    ).first();

    const href = await rssLink.getAttribute("href");

    if (href) {
      console.log("RSS Feed URL:", href);
    } else {
      console.log("No RSS link found.");
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await browser.close();
  }
}

// Change URL here
await extractRSS("https://www.youtube.com/@GoogleDevelopers");

