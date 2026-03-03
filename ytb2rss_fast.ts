const url = "https://www.youtube.com/@GoogleDevelopers";

const res = await fetch(url);
const html = await res.text();

const match = html.match(
  /<link[^>]+rel="alternate"[^>]+type="application\/rss\+xml"[^>]+href="([^"]+)"/i
);

if (match) {
  console.log("RSS Feed URL:", match[1]);
} else {
  console.log("No RSS link found.");
}

