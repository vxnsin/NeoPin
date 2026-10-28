import { ActionSheetIOS, Alert, Platform } from "react-native";

export type PhotoChoice = "pick" | "remove";

export type PhotoMenuItem = { label: string; choice: PhotoChoice | null; destructive?: boolean };

// The choices behind the camera badge. Cancel comes first, where the iOS sheet wants it.
export function photoMenuItems(hasPhoto: boolean): PhotoMenuItem[] {
  if (!hasPhoto) {
    return [
      { label: "Cancel", choice: null },
      { label: "Choose a photo", choice: "pick" },
    ];
  }
  return [
    { label: "Cancel", choice: null },
    { label: "Choose a new photo", choice: "pick" },
    { label: "Remove photo", choice: "remove", destructive: true },
  ];
}

// Asks with the system's own menu: the action sheet on iOS, the dialog on Android, which has no
// sheet of its own. Resolves to null when the menu is dismissed.
export function askPhotoChoice(hasPhoto: boolean): Promise<PhotoChoice | null> {
  const items = photoMenuItems(hasPhoto);

  if (Platform.OS === "ios") {
    const destructive = items.findIndex((item) => item.destructive);
    return new Promise((resolve) => {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: "Profile photo",
          options: items.map((item) => item.label),
          cancelButtonIndex: 0,
          destructiveButtonIndex: destructive >= 0 ? destructive : undefined,
        },
        (index) => resolve(items[index]?.choice ?? null)
      );
    });
  }

  // The web build has no dialog to ask with; it goes straight to the picker.
  if (Platform.OS === "web") return Promise.resolve("pick");

  // Android lays its three buttons out as neutral, negative, positive: the destructive one goes
  // left, cancel in the middle, the pick on the right.
  return new Promise((resolve) => {
    let settled = false;
    const done = (choice: PhotoChoice | null) => {
      if (settled) return;
      settled = true;
      resolve(choice);
    };
    const button = (item: PhotoMenuItem) => ({
      text: item.label,
      style: item.destructive ? ("destructive" as const) : item.choice === null ? ("cancel" as const) : ("default" as const),
      onPress: () => done(item.choice),
    });
    const cancel = items[0];
    const pick = items.find((item) => item.choice === "pick")!;
    const remove = items.find((item) => item.choice === "remove");
    const buttons = remove ? [button(remove), button(cancel), button(pick)] : [button(cancel), button(pick)];
    Alert.alert("Profile photo", undefined, buttons, { cancelable: true, onDismiss: () => done(null) });
  });
}
