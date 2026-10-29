import { inviteRedirect } from "@/lib/invite";

// Every link the system hands the app passes here first. Invite links from older server pages
// carry "server=https://…", and a "://" in the query keeps the router from finding /invite.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    return inviteRedirect(path) ?? path;
  } catch {
    return path;
  }
}
