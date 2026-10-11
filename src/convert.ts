import { CHANNEL_ID, normalizeInput, parseInput } from "./input.ts";
import { createChannelResolver } from "./youtube.ts";
import type { ChannelResolver, ResolvedChannel } from "./youtube.ts";

export interface Feed extends ResolvedChannel {
  feedUrl: string;
  channelUrl: string;
}

export interface CachedChannel extends ResolvedChannel {
  resolvedAt: number;
}

export interface ConversionFailure {
  line: number;
  input: string;
  message: string;
}

export interface ConversionResult {
  feeds: Feed[];
  failures: ConversionFailure[];
  duplicates: number;
  total: number;
}

export interface ConvertOptions {
  resolve?: ChannelResolver;
  cache?: Map<string, CachedChannel>;
  onResolved?: (key: string, channel: CachedChannel) => void | Promise<void>;
  now?: () => number;
}

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isFreshCache(channel: CachedChannel, now = Date.now()): boolean {
  return CHANNEL_ID.test(channel.channelId) && typeof channel.title === "string"
    && Number.isFinite(channel.resolvedAt) && channel.resolvedAt <= now && now - channel.resolvedAt < CACHE_TTL_MS;
}

export async function convertChannels(text: string, options: ConvertOptions = {}): Promise<ConversionResult> {
  const lines = parseInput(text);
  const result: ConversionResult = { feeds: [], failures: [], duplicates: 0, total: lines.length };
  const seenInputs = new Set<string>();
  const seenIds = new Set<string>();
  const resolve = options.resolve ?? createChannelResolver();
  const now = options.now ?? Date.now;
  for (const line of lines) {
    let resolved: ResolvedChannel;
    let cacheEntry: CachedChannel | undefined;
    let key: string;
    try {
      const input = normalizeInput(line.value);
      key = input.key;
      if (seenInputs.has(key)) { result.duplicates++; continue; }
      seenInputs.add(key);
      const cached = options.cache?.get(key);
      if (input.channelId) resolved = { channelId: input.channelId, title: input.label };
      else if (cached && isFreshCache(cached, now())) resolved = cached;
      else {
        resolved = await resolve(input);
        if (!CHANNEL_ID.test(resolved.channelId)) throw new Error("Lookup returned an invalid channel ID.");
        cacheEntry = { ...resolved, resolvedAt: now() };
      }
    } catch (error) {
      result.failures.push({ line: line.line, input: line.value, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (cacheEntry) {
      options.cache?.set(key, cacheEntry);
      // Storage failures are fatal, rather than being mistaken for a bad channel.
      await options.onResolved?.(key, cacheEntry);
    }
    if (seenIds.has(resolved.channelId)) { result.duplicates++; continue; }
    seenIds.add(resolved.channelId);
    result.feeds.push({
      channelId: resolved.channelId,
      title: resolved.title || resolved.channelId,
      feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${resolved.channelId}`,
      channelUrl: `https://www.youtube.com/channel/${resolved.channelId}`,
    });
  }
  return result;
}
