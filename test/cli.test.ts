import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { link, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.ts";
import { readCache } from "../src/storage.ts";
import { VERSION } from "../src/version.ts";

const ID = "UCBLCvUUCiSqBCEc-TqZ9rGw";
const FEED = `https://www.youtube.com/feeds/videos.xml?channel_id=${ID}`;
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
let directory: string;
let input: string;
let out: string;
let errors: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ytb2rss-test-"));
  input = join(directory, "channels.txt");
  await writeFile(input, `${ID}\n`);
  out = "";
  errors = "";
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const io = () => ({ stdout: (text: string) => { out += text; }, stderr: (text: string) => { errors += text; } });

describe("CLI", () => {
  test("shows the package version without needing an input file", async () => {
    expect(await runCli(["--version"], io())).toBe(0);
    expect(out).toBe(`ytb2rss ${VERSION}\n`);
    expect(errors).toBe("");
  });

  test("the actual executable exports an offline list with diagnostics only on stderr", async () => {
    const child = Bun.spawn([process.execPath, CLI, input, "--no-cache"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe(`${FEED}\n`);
    expect(stderr).toContain("1 feed(s)");
  });

  test("writes an OPML file via the documented flags without leaking it to stdout", async () => {
    const output = join(directory, "subscriptions.opml");
    const child = Bun.spawn([process.execPath, CLI, input, "-f", "opml", "-o", output, "--no-cache"], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await readFile(output, "utf8")).toContain(`xmlUrl="${FEED}"`);
    expect((await readdir(directory)).some(file => file.endsWith(".tmp"))).toBe(false);
  });

  test("accepts --category and writes the Miniflux-compatible parent outline", async () => {
    expect(await runCli([input, "--no-cache", "-f", "opml", "--category", "YouTube"], io())).toBe(0);
    expect(out).toContain('<outline text="YouTube" title="YouTube">\n      <outline type="rss"');
    expect(out).toContain("    </outline>\n  </body>");
  });

  test("partial failures keep valid output, report original line numbers, and return 1", async () => {
    await writeFile(input, `# comment\n${ID}\ninvalid\n`);
    const failures = join(directory, "failures.json");
    expect(await runCli([input, "--no-cache", "--failures", failures], io())).toBe(1);
    expect(out).toBe(`${FEED}\n`);
    expect(errors).toContain("Line 3 (invalid)");
    expect(JSON.parse(await readFile(failures, "utf8"))).toMatchObject([{ line: 3, input: "invalid" }]);
  });

  test("persists lookup results across CLI invocations", async () => {
    await writeFile(input, "@juanrallo\n");
    const cachePath = join(directory, "cache.json");
    let lookups = 0;
    const dependencies = { ...io(), resolve: async () => { lookups++; return { channelId: ID, title: "Rallo" }; } };
    expect(await runCli([input, "--cache", cachePath], dependencies)).toBe(0);
    expect(await runCli([input, "--cache", cachePath], dependencies)).toBe(0);
    expect(lookups).toBe(1);
    expect((await readCache(cachePath)).get("@juanrallo")?.channelId).toBe(ID);
  });

  test("does not create a cache file for offline IDs", async () => {
    const cachePath = join(directory, "cache.json");
    expect(await runCli([input, "--cache", cachePath], io())).toBe(0);
    expect(await readdir(directory)).toEqual(["channels.txt"]);
  });

  test("reports a malformed cache without overwriting it, and --no-cache can bypass it", async () => {
    const cachePath = join(directory, "cache.json");
    await writeFile(cachePath, "broken JSON");
    expect(await runCli([input, "--cache", cachePath], io())).toBe(2);
    expect(errors).toContain("--no-cache");
    expect(await readFile(cachePath, "utf8")).toBe("broken JSON");
    expect(await runCli([input, "--no-cache"], io())).toBe(0);
  });

  test("fails cleanly for a missing input or output directory", async () => {
    expect(await runCli([join(directory, "missing.txt"), "--no-cache"], io())).toBe(2);
    expect(await runCli([input, "--no-cache", "-o", join(directory, "missing", "feeds.txt")], io())).toBe(2);
    expect(out).toBe("");
  });

  test.each([
    [], ["--unknown"], ["--format", "json"], ["--timeout", "0"], ["--retries", "-1"],
    ["--delay", "1.5"], ["--delay", "NaN"], ["--cache", "cache.json", "--no-cache"], ["--output", ""],
    ["--category", "YouTube"], ["--format", "opml", "--category", ""], ["--format", "opml", "--category", "   "],
  ].map(args => ({ args })))("rejects invalid arguments: %j", async ({ args }) => {
    const arguments_ = args.length ? [input, ...args] : [];
    expect(await runCli(arguments_, io())).toBe(2);
    expect(out).toBe("");
  });

  test("shows help without needing an input file", async () => {
    expect(await runCli(["--help"], io())).toBe(0);
    expect(out).toContain("--format <text|opml>");
    expect(out).toContain("--version");
    expect(errors).toBe("");
  });

  test("refuses to overwrite the input, including through symlink and hard-link aliases", async () => {
    const symbolic = join(directory, "symbolic.txt");
    const hard = join(directory, "hard.txt");
    await symlink(input, symbolic);
    await link(input, hard);
    for (const target of [input, symbolic, hard]) {
      expect(await runCli([input, "--no-cache", "-o", target], io())).toBe(2);
    }
    expect(await readFile(input, "utf8")).toBe(`${ID}\n`);
  });

  test("rejects collisions between output, cache, and failure report paths", async () => {
    const shared = join(directory, "shared.json");
    expect(await runCli([input, "-o", shared, "--cache", shared], io())).toBe(2);
    expect(await runCli([input, "-o", shared, "--failures", shared, "--no-cache"], io())).toBe(2);
    expect(await readdir(directory)).toEqual(["channels.txt"]);
  });

  test("a comments-only file succeeds with an empty export", async () => {
    await writeFile(input, "# empty\n\n");
    expect(await runCli([input, "--no-cache"], io())).toBe(0);
    expect(out).toBe("");
    expect(errors).toContain("0 feed(s)");
  });
});
