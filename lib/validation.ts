// The same rules the server applies on registration.
export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
export const PASSWORD_MIN = 8;

export function usernameError(username: string): string | undefined {
  const value = username.trim();
  if (!value) return "Username is required";
  if (!USERNAME_PATTERN.test(value)) return "3-32 characters: letters, digits, _ . -";
  return undefined;
}

export function passwordError(password: string, creating: boolean): string | undefined {
  if (!password) return "Password is required";
  if (creating && password.length < PASSWORD_MIN) return `At least ${PASSWORD_MIN} characters`;
  return undefined;
}
