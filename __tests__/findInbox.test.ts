import { holdFindRequest, takeFindRequest } from "../lib/findInbox";

const request = { type: "findRequest", session: "s1", from: { id: 1 }, expiresAt: 10_000 };

test("a request that came before the screen is handed over once", () => {
  holdFindRequest(request);
  expect(takeFindRequest(5_000)).toEqual(request);
  expect(takeFindRequest(5_000)).toBeNull();
});

test("an expired or ended request is dropped", () => {
  holdFindRequest(request);
  expect(takeFindRequest(10_001)).toBeNull();
  holdFindRequest(request);
  holdFindRequest({ type: "findEnded", session: "s1", reason: "timeout" });
  expect(takeFindRequest(5_000)).toBeNull();
});
