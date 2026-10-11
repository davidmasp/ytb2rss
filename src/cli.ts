#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve as absolute, dirname, basename } from "node:path";
import { convertChannels } from "./convert.ts";
import { formatFeeds } from "./output.ts";
import type { OutputFormat } from "./output.ts";
import { atomicWrite, readCache, writeCache } from "./storage.ts";
import { createChannelResolver } from "./youtube.ts";
import type { ChannelResolver } from "./youtube.ts";
import { VERSION } from "./version.ts";

const HELP = `Usage: ytb2rss <channels.txt> [options]
       bun run convert <channels.txt> [options]

Convert one YouTube channel ID per line to feed URLs or OPML.
IDs are converted offline. Handles and channel URLs are also supported.

Options:
  -f, --format <text|opml>  Output format (default: text)
  -o, --output <file>       Write output to a file (default: stdout)
      --category <name>     Group OPML feeds into one category (e.g. YouTube)
      --failures <file>     Also save failed lines as JSON
      --cache <file>        Lookup cache (default: .ytb2rss-cache.json)
      --no-cache            Disable lookup caching
      --timeout <ms>        Timeout per lookup attempt (default: 10000)
      --retries <count>     Retries for temporary failures (default: 2)
      --delay <ms>          Delay between lookups (default: 500)
  -V, --version             Show version
  -h, --help                Show help

Blank lines and lines beginning with # are ignored. Duplicate channels are skipped.
Diagnostics go to stderr. Exit codes: 0 success, 1 partial failure, 2 CLI/file error.
`;

interface CliIO {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  resolve?: ChannelResolver;
}

function integer(value: string | undefined, fallback: number, name: string, minimum: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(result) || result < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}.`);
  }
  return result;
}

// Check both normalized paths and existing file identities before any writes.
async function checkPaths(paths: string[]): Promise<void> {
  const identities = new Set<string>();
  for (const path of paths) {
    const full = absolute(path);
    let canonical: string;
    try { canonical = await realpath(full); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      canonical = absolute(await realpath(dirname(full)), basename(full));
    }
    const pathKey = `path:${canonical}`;
    if (identities.has(pathKey)) throw new Error("Input, output, cache, and failure report must use different files.");
    identities.add(pathKey);
    try {
      const info = await stat(full);
      if (!info.isFile()) throw new Error(`Expected a file: ${path}`);
      const fileKey = `file:${info.dev}:${info.ino}`;
      if (identities.has(fileKey)) throw new Error("Input, output, cache, and failure report must use different files.");
      identities.add(fileKey);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function runCli(args: string[], io: CliIO = {}): Promise<number> {
  const stdout = io.stdout ?? (text => { process.stdout.write(text); });
  const stderr = io.stderr ?? (text => { process.stderr.write(text); });
  try {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true, strict: true,
      options: {
        format: { type: "string", short: "f", default: "text" },
        output: { type: "string", short: "o" },
        category: { type: "string" },
        failures: { type: "string" },
        cache: { type: "string" },
        "no-cache": { type: "boolean" },
        timeout: { type: "string" },
        retries: { type: "string" },
        delay: { type: "string" },
        version: { type: "boolean", short: "V" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.version) { stdout(`ytb2rss ${VERSION}\n`); return 0; }
    if (values.help) { stdout(HELP); return 0; }
    const input = positionals[0];
    if (!input || positionals.length !== 1) throw new Error("Provide exactly one input text file. See --help.");
    if (values.format !== "text" && values.format !== "opml") throw new Error("--format must be text or opml.");
    if (values.category !== undefined) {
      if (!values.category.trim()) throw new Error("--category needs a non-empty name.");
      if (values.format !== "opml") throw new Error("--category requires --format opml.");
    }
    if (values.cache && values["no-cache"]) throw new Error("Choose either --cache or --no-cache.");
    for (const name of ["output", "failures", "cache"] as const) {
      if (values[name] !== undefined && !values[name]?.trim()) throw new Error(`--${name} needs a file path.`);
    }
    const resolver = io.resolve ?? createChannelResolver({
      timeoutMs: integer(values.timeout, 10_000, "--timeout", 1),
      retries: integer(values.retries, 2, "--retries", 0),
      delayMs: integer(values.delay, 500, "--delay", 0),
    });
    const cachePath = values["no-cache"] ? undefined : values.cache ?? ".ytb2rss-cache.json";
    await checkPaths([input, values.output, values.failures, cachePath].filter((path): path is string => path !== undefined));
    const text = await readFile(input, "utf8");
    const cache = cachePath ? await readCache(cachePath) : undefined;
    const result = await convertChannels(text, {
      resolve: resolver, cache,
      onResolved: cachePath && cache ? async () => { await writeCache(cachePath, cache); } : undefined,
    });
    const output = formatFeeds(result.feeds, values.format as OutputFormat, { category: values.category });
    if (values.output) await atomicWrite(values.output, output);
    else stdout(output);
    if (values.failures) await atomicWrite(values.failures, `${JSON.stringify(result.failures, null, 2)}\n`);
    for (const failure of result.failures) stderr(`Line ${failure.line} (${failure.input}): ${failure.message}\n`);
    stderr(`${result.feeds.length} feed(s), ${result.duplicates} duplicate(s), ${result.failures.length} failure(s).\n`);
    return result.failures.length ? 1 : 0;
  } catch (error) {
    stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2));
