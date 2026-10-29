import { Redirect, useLocalSearchParams } from "expo-router";
import { serverFromLink } from "@/lib/invite";

// neopin://invite?code=XXXXX-XXXXX&server=https://... lands here (the server's /invite page sends
// it) and goes on to the login screen in invite mode, with the server filled in when it came along.
export default function Invite() {
  const { code, server } = useLocalSearchParams<{ code?: string; server?: string }>();
  const params: Record<string, string> = {};
  if (typeof code === "string" && code) params.code = code;
  const from = serverFromLink(server);
  if (from) params.server = from;
  return <Redirect href={{ pathname: "/login", params }} />;
}
