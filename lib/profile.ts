export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
export const DISPLAY_NAME_MAX = 48;

export function usernameProblem(username: string): string | undefined {
  const value = username.trim();
  if (!value) return "Username is required.";
  if (!USERNAME_PATTERN.test(value)) return "3-32 characters: letters, digits, _ . -";
  return undefined;
}

export function displayNameProblem(name: string): string | undefined {
  const value = name.trim();
  if (!value) return "Name must not be empty.";
  if (value.length > DISPLAY_NAME_MAX) return `At most ${DISPLAY_NAME_MAX} characters.`;
  return undefined;
}

// Only what changed goes to the server. Empty when nothing did.
export function profileChanges(
  current: { displayName: string; username: string },
  next: { displayName: string; username: string }
): { displayName?: string; username?: string } {
  const changes: { displayName?: string; username?: string } = {};
  if (next.displayName.trim() !== current.displayName) changes.displayName = next.displayName.trim();
  if (next.username.trim() !== current.username) changes.username = next.username.trim();
  return changes;
}
