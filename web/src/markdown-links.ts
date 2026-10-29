export function safeLink(href: string): string | null {
  try {
    const url = new URL(href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
