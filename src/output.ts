import type { Feed } from "./convert.ts";

export type OutputFormat = "text" | "opml";

export interface OutputOptions {
  category?: string;
}

function xml(value: string): string {
  return value.toWellFormed().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    .replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
}

export function formatFeeds(feeds: readonly Feed[], format: OutputFormat = "text", options: OutputOptions = {}): string {
  const category = options.category?.trim();
  if (options.category !== undefined && !category) throw new Error("Category must have a non-empty name.");
  if (category && format !== "opml") throw new Error("A category requires OPML output.");
  if (format === "text") return feeds.length ? `${feeds.map(feed => feed.feedUrl).join("\n")}\n` : "";
  const indent = category ? "      " : "    ";
  const outlines = feeds.map(feed =>
    `${indent}<outline type="rss" text="${xml(feed.title)}" title="${xml(feed.title)}" xmlUrl="${xml(feed.feedUrl)}" htmlUrl="${xml(feed.channelUrl)}" />`);
  const body = category ? [
    `    <outline text="${xml(category)}" title="${xml(category)}">`,
    ...outlines,
    "    </outline>",
  ] : outlines;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head><title>YouTube subscriptions</title></head>",
    "  <body>",
    ...body,
    "  </body>",
    "</opml>",
    "",
  ].join("\n");
}
