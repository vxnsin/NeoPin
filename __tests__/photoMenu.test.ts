import { ActionSheetIOS, Alert, Platform } from "react-native";
import { askPhotoChoice, photoMenuItems } from "../lib/photoMenu";

function onPlatform(os: string) {
  Object.defineProperty(Platform, "OS", { value: os, configurable: true });
}

describe("photoMenuItems", () => {
  it("offers only a pick without a photo, cancel first", () => {
    expect(photoMenuItems(false).map((item) => item.choice)).toEqual([null, "pick"]);
  });

  it("adds a destructive remove with a photo", () => {
    const items = photoMenuItems(true);
    expect(items.map((item) => item.choice)).toEqual([null, "pick", "remove"]);
    expect(items[2].destructive).toBe(true);
  });
});

describe("askPhotoChoice", () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    onPlatform(originalOS);
    jest.restoreAllMocks();
  });

  it("uses the iOS action sheet and maps the tapped index", async () => {
    onPlatform("ios");
    const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation((options, callback) => {
      expect(options.options).toEqual(["Cancel", "Choose a new photo", "Remove photo"]);
      expect(options.cancelButtonIndex).toBe(0);
      expect(options.destructiveButtonIndex).toBe(2);
      callback(2);
    });
    await expect(askPhotoChoice(true)).resolves.toBe("remove");
    expect(sheet).toHaveBeenCalledTimes(1);
  });

  it("resolves null when the iOS sheet is cancelled", async () => {
    onPlatform("ios");
    jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation((_options, callback) => callback(0));
    await expect(askPhotoChoice(false)).resolves.toBeNull();
  });

  it("uses the Android dialog with remove on the left and pick on the right", async () => {
    onPlatform("android");
    const alert = jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      expect(buttons?.map((button) => button.text)).toEqual(["Remove photo", "Cancel", "Choose a new photo"]);
      expect(buttons?.[0].style).toBe("destructive");
      expect(buttons?.[1].style).toBe("cancel");
      buttons?.[2].onPress?.();
    });
    await expect(askPhotoChoice(true)).resolves.toBe("pick");
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("resolves null when the Android dialog is dismissed", async () => {
    onPlatform("android");
    jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons, options) => {
      expect(buttons?.map((button) => button.text)).toEqual(["Cancel", "Choose a photo"]);
      options?.onDismiss?.();
    });
    await expect(askPhotoChoice(false)).resolves.toBeNull();
  });
});
