export const SEARCH_MAX = 64;
export const SEARCH_DELAY_MS = 200;

// What goes to the server: trimmed and cut to the length it accepts. Blank means no search.
export function searchQuery(text: string): string {
  return text.trim().slice(0, SEARCH_MAX);
}
