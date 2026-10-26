export const PASSWORD_MIN = 8;

// Checks a password change before it goes to the server. Returns the problem, or undefined.
export function passwordProblem(current: string, next: string, confirm: string): string | undefined {
  if (!current) return "Enter your current password.";
  if (next.length < PASSWORD_MIN) return `The new password needs at least ${PASSWORD_MIN} characters.`;
  if (next !== confirm) return "The new passwords do not match.";
  if (next === current) return "The new password has to differ from the current one.";
  return undefined;
}
