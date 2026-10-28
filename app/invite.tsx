import { Redirect, useLocalSearchParams } from "expo-router";

// neopin://invite?code=XXXXX-XXXXX lands here and goes on to the login screen in invite mode.
export default function Invite() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  return <Redirect href={{ pathname: "/login", params: typeof code === "string" && code ? { code } : {} }} />;
}
