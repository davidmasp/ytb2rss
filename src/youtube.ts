import { decodeHTML, decodeHTMLAttribute } from "entities";
import { CHANNEL_ID, isYouTubeUrl } from "./input.ts";
import { VERSION } from "./version.ts";
import type { ChannelInput } from "./input.ts";

export interface ResolvedChannel {
  channelId: string;
  title: string;
}

export type ChannelResolver = (input: ChannelInput) => Promise<ResolvedChannel>;

export class LookupError extends Error {
  constructor(message: string, readonly retryable = false, readonly retryAfterMs = 0) {
    super(message);
    this.name = "LookupError";
  }
}

// Only read the channel's metadata object; unrelated channel IDs can appear in recommendations.
function channelMetadata(html: string): Record<string, unknown> | undefined {
  const match = /"channelMetadataRenderer"\s*:\s*\{/.exec(html);
  if (!match) return;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try { return JSON.parse(html.slice(start, index + 1)); } catch { return; }
    }
  }
}

function idFromUrl(value: string, base: string, feed: boolean): string | undefined {
  try {
    const url = new URL(value, base);
    if (!isYouTubeUrl(url)) return;
    const id = feed && url.pathname === "/feeds/videos.xml"
      ? url.searchParams.get("channel_id")
      : !feed ? /^\/channel\/(UC[A-Za-z0-9_-]{22})\/?$/.exec(url.pathname)?.[1] : undefined;
    return id && CHANNEL_ID.test(id) ? id : undefined;
  } catch { return; }
}

export function extractChannel(html: string, pageUrl: string): ResolvedChannel {
  let feedId: string | undefined;
  let canonicalId: string | undefined;
  let metaId: string | undefined;
  let title = "";
  let pageTitle = "";
  new HTMLRewriter()
    .on("link", { element(element) {
      const attribute = element.getAttribute("href");
      if (!attribute) return;
      const href = decodeHTMLAttribute(attribute);
      const type = element.getAttribute("type")?.toLowerCase();
      if (type === "application/rss+xml" || type === "application/atom+xml") {
        feedId ??= idFromUrl(href, pageUrl, true);
      }
      if (element.getAttribute("rel")?.toLowerCase() === "canonical") {
        canonicalId ??= idFromUrl(href, pageUrl, false);
      }
    } })
    .on("meta", { element(element) {
      const attribute = element.getAttribute("content");
      const content = attribute ? decodeHTMLAttribute(attribute) : undefined;
      if (element.getAttribute("itemprop") === "channelId" && content && CHANNEL_ID.test(content)) metaId = content;
      if (element.getAttribute("property") === "og:title" && content) title = content;
    } })
    .on("title", { text(chunk) { pageTitle += chunk.text; } })
    .transform(html);

  const metadata = channelMetadata(html);
  const externalId = metadata?.externalId;
  const metadataId = typeof externalId === "string" && CHANNEL_ID.test(externalId) ? externalId
    : typeof metadata?.channelUrl === "string" ? idFromUrl(metadata.channelUrl, pageUrl, false) : undefined;
  const channelId = feedId ?? metadataId ?? canonicalId ?? metaId;
  if (!channelId && /before you continue|unusual traffic|^sorry\b/i.test(pageTitle.trim())) {
    throw new LookupError("YouTube returned a consent or blocking page.");
  }
  if (!channelId) throw new LookupError("No channel feed or channel metadata found; YouTube may have returned a consent or blocking page.");
  return {
    channelId,
    title: typeof metadata?.title === "string" && metadata.title.trim() ? metadata.title
      : title || decodeHTML(pageTitle).replace(/\s*-\s*YouTube\s*$/, "").trim() || channelId,
  };
}

export interface ResolverOptions {
  timeoutMs?: number;
  retries?: number;
  delayMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_PAGE_BYTES = 5 * 1024 * 1024;

async function readPage(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const decoder = new TextDecoder();
  let size = 0;
  let html = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_PAGE_BYTES) throw new LookupError("Channel page exceeded the 5 MB size limit.");
      html += decoder.decode(chunk.value, { stream: true });
    }
    return html + decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

async function fetchChannel(input: ChannelInput, request: NonNullable<ResolverOptions["fetch"]>, signal: AbortSignal): Promise<ResolvedChannel> {
  let url = input.url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await request(url, {
      signal,
      redirect: "manual",
      headers: { "User-Agent": `ytb2rss/${VERSION}`, Accept: "text/html" },
    });
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location) throw new LookupError("YouTube returned a redirect without a location.");
      const next = new URL(location, url);
      if (!isYouTubeUrl(next)) throw new LookupError("YouTube redirected to a consent page or an unsupported host.");
      url = next.href;
      continue;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
      const dateDelay = retryAfter && !seconds ? Date.parse(retryAfter) - Date.now() : 0;
      throw new LookupError(`YouTube returned HTTP ${response.status}.`,
        response.status === 429 || response.status >= 500,
        Math.min(5000, Math.max(0, seconds || dateDelay || 0)));
    }
    return extractChannel(await readPage(response, signal), url);
  }
  throw new LookupError("YouTube returned too many redirects.");
}

export function createChannelResolver(options: ResolverOptions = {}): ChannelResolver {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = options.retries ?? 2;
  const delayMs = options.delayMs ?? 500;
  for (const [name, value, minimum] of [["timeoutMs", timeoutMs, 1], ["retries", retries, 0], ["delayMs", delayMs, 0]] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}.`);
  }
  const request = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? (async ms => { await Bun.sleep(ms); });
  let requested = false;
  return async input => {
    if (input.channelId) return { channelId: input.channelId, title: input.label };
    for (let attempt = 0; ; attempt++) {
      if (requested && delayMs) await sleep(delayMs);
      requested = true;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Bound both fetching headers and reading the response body, including redirects.
        return await Promise.race([
          fetchChannel(input, request, controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new LookupError(`Channel lookup timed out after ${timeoutMs} ms.`, true));
            }, timeoutMs);
          }),
        ]);
      } catch (error) {
        clearTimeout(timer);
        const failure = error instanceof LookupError ? error
          : new LookupError(`Network request failed: ${error instanceof Error ? error.message : String(error)}`, true);
        if (!failure.retryable || attempt >= retries) throw failure;
        await sleep(Math.max(failure.retryAfterMs, Math.min(5000, 500 * 2 ** attempt)));
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
