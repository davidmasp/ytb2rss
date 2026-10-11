export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const TABS = new Set(["videos", "shorts", "streams", "featured", "about", "community", "playlists"]);

export interface ChannelInput {
  key: string;
  url: string;
  label: string;
  channelId?: string;
}

export interface InputLine {
  value: string;
  line: number;
}

export function parseInput(text: string): InputLine[] {
  return text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/).flatMap((line, index) => {
    const value = line.trim();
    return !value || value.startsWith("#") ? [] : [{ value, line: index + 1 }];
  });
}

export function isYouTubeUrl(url: URL): boolean {
  return ["https:", "http:"].includes(url.protocol) && HOSTS.has(url.hostname)
    && !url.username && !url.password && !url.port;
}

function fromId(id: string): ChannelInput {
  if (!CHANNEL_ID.test(id)) throw new Error("Invalid channel ID: expected UC followed by 22 letters, digits, underscores, or hyphens.");
  return { key: id, url: `https://www.youtube.com/channel/${id}`, label: id, channelId: id };
}

function fromHandle(handle: string): ChannelInput {
  const name = handle.slice(1);
  if (!name || /[\s/@?#<>]/u.test(name)) throw new Error("Invalid YouTube handle.");
  return { key: handle.toLowerCase(), url: `https://www.youtube.com/@${encodeURIComponent(name)}`, label: handle };
}

export function normalizeInput(value: string): ChannelInput {
  value = value.trim();
  if (CHANNEL_ID.test(value)) return fromId(value);
  if (value.startsWith("@")) return fromHandle(value);
  if (/^(?:www\.|m\.)?youtube\.com\//i.test(value)) value = `https://${value}`;

  let url: URL;
  try { url = new URL(value); } catch {
    throw new Error("Expected a UC… channel ID, @handle, or YouTube channel URL.");
  }
  if (!isYouTubeUrl(url)) throw new Error("Expected a YouTube channel URL.");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const first = parts[0];
  if (first?.startsWith("@") && parts.length <= 2 && (!parts[1] || TABS.has(parts[1]))) {
    return fromHandle(first);
  }
  if (first === "channel" && parts[1] && parts.length <= 3 && (!parts[2] || TABS.has(parts[2]))) {
    return fromId(parts[1]);
  }
  if ((first === "user" || first === "c") && parts[1] && !/[\s/?#<>]/u.test(parts[1])
      && parts.length <= 3 && (!parts[2] || TABS.has(parts[2]))) {
    return {
      key: `${first}/${parts[1]}`,
      url: `https://www.youtube.com/${first}/${encodeURIComponent(parts[1])}`,
      label: parts[1],
    };
  }
  throw new Error("Unsupported URL: use a channel page rather than a video or playlist.");
}
