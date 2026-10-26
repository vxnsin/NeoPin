import { SEARCH_MAX, searchQuery } from "../lib/search";
import { searchUsers } from "../lib/api";

test("the query is trimmed, blank stays blank and long input is cut", () => {
  expect(searchQuery("  an ")).toBe("an");
  expect(searchQuery("   ")).toBe("");
  expect(searchQuery("x".repeat(100))).toHaveLength(SEARCH_MAX);
});

test("the search asks with the text and the group, encoded", async () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] });
  (global as any).fetch = fetchMock;
  const auth = { serverIp: "ws://10.0.0.2:3012", deviceId: "d", token: "t" };
  await searchUsers(auth, "an na", 4);
  expect(fetchMock.mock.calls[0][0]).toBe("http://10.0.0.2:3012/api/users/search?q=an%20na&groupId=4");
  await searchUsers(auth, "x");
  expect(fetchMock.mock.calls[1][0]).toBe("http://10.0.0.2:3012/api/users/search?q=x");
  (global as any).fetch = undefined;
});
