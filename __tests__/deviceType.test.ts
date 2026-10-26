import { deviceTypeFrom } from "../lib/deviceType";
import { typeOf } from "../lib/devices";

test("expo-device types map to the server's names", () => {
  expect(deviceTypeFrom(1)).toBe("phone");
  expect(deviceTypeFrom(2)).toBe("tablet");
  expect(deviceTypeFrom(3)).toBe("desktop");
  expect(deviceTypeFrom(0)).toBe("phone");
  expect(deviceTypeFrom(4)).toBe("phone");
  expect(deviceTypeFrom(null)).toBe("phone");
});

test("a device without a known type is a phone", () => {
  expect(typeOf({})).toBe("phone");
  expect(typeOf({ deviceType: "desktop" })).toBe("desktop");
  expect(typeOf({ deviceType: "toaster" })).toBe("phone");
});
