jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import React from "react";
import { Text } from "react-native";
import renderer, { act } from "react-test-renderer";
import TourOverlay from "../components/TourOverlay";
import { tourSteps } from "../lib/tour";

jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@expo/vector-icons", () => ({ MaterialIcons: () => null }));

const texts = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType(Text).map((t) => [].concat(t.props.children).join(""));
const press = (tree: renderer.ReactTestRenderer, label: string) =>
  tree.root.findAll((node) => typeof node.props.onPress === "function" && (node.props.accessibilityLabel === label || texts({ root: node } as any).includes(label)))[0].props.onPress();

beforeEach(() => jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick", "setImmediate"] }));
afterEach(() => jest.useRealTimers());

// Fades, a measurement in between, then the glide: a few rounds of promises and timers.
const settle = async () => {
  for (let round = 0; round < 4; round++) {
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(400);
    });
  }
};

test("walks through every step and ends with Done", async () => {
  const steps = tourSteps(true);
  const onFinish = jest.fn();
  const measure = jest.fn(async () => ({ x: 20, y: 700, width: 300, height: 68, radius: 22 }));
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<TourOverlay steps={steps} measure={measure} onFinish={onFinish} dashboard="https://neopin.example.org" />);
  });
  await settle();
  expect(texts(tree)).toContain(steps[0].title);
  expect(texts(tree)).toContain(`1 of ${steps.length}`);
  for (let i = 1; i < steps.length; i++) {
    await act(async () => press(tree, "Next"));
    await settle();
    expect(texts(tree)).toContain(steps[i].title);
  }
  // The admin step links the dashboard, and the last button says Done.
  expect(texts(tree)).toContain("neopin.example.org");
  expect(texts(tree)).not.toContain("Skip");
  await act(async () => press(tree, "Done"));
  await settle();
  expect(onFinish).toHaveBeenCalledTimes(1);
  // Only the steps with a target were measured; the map ones point nowhere.
  expect(measure.mock.calls.map((call: any[]) => call[0])).not.toContain("map");
});

test("Skip ends it at once", async () => {
  const onFinish = jest.fn();
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<TourOverlay steps={tourSteps(false)} measure={async () => null} onFinish={onFinish} />);
  });
  await settle();
  await act(async () => press(tree, "Skip the tour"));
  await settle();
  expect(onFinish).toHaveBeenCalledTimes(1);
});
