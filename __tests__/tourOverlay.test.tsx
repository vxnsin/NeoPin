jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import React, { useState } from "react";
import { Text } from "react-native";
import renderer, { act } from "react-test-renderer";
import TourOverlay, { type TourRect } from "../components/TourOverlay";
import { tourSteps, type TourTarget } from "../lib/tour";

jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@expo/vector-icons", () => ({ MaterialIcons: () => null }));

const texts = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType(Text).map((t) => [].concat(t.props.children).join(""));
const press = (tree: renderer.ReactTestRenderer, label: string) =>
  tree.root.findAll((node) => typeof node.props.onPress === "function" && (node.props.accessibilityLabel === label || texts({ root: node } as any).includes(label)))[0].props.onPress();

beforeEach(() => jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick", "setImmediate"] }));
afterEach(() => jest.useRealTimers());

// Fades, a measurement in between, then the glide: a few rounds of promises and timers.
const settle = async () => {
  for (let round = 0; round < 8; round++) {
    await act(async () => {
      for (let tick = 0; tick < 5; tick++) await Promise.resolve();
      jest.advanceTimersByTime(400);
    });
  }
};

// Like the map screen: the index lives outside, and a step on another sheet gets a fresh overlay.
function Host({ isAdmin, measure, onFinish }: { isAdmin: boolean; measure: (t: TourTarget) => Promise<TourRect | null>; onFinish: () => void }) {
  const steps = tourSteps(isAdmin);
  const [index, setIndex] = useState(0);
  return (
    <TourOverlay
      key={String(steps[index].sheet)}
      steps={steps}
      index={index}
      onIndex={setIndex}
      onFinish={onFinish}
      measure={measure}
      delay={100}
      dashboard="https://neopin.example.org"
    />
  );
}

test("walks through every control, across the sheets, and ends with Done", async () => {
  const steps = tourSteps(true);
  const onFinish = jest.fn();
  // The Find button is not there (nobody online): that step falls back to the middle.
  const measure = jest.fn(async (target: TourTarget) => (target === "findButton" ? null : { x: 20, y: 600, width: 300, height: 52, radius: 14 }));
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<Host isAdmin measure={measure} onFinish={onFinish} />);
  });
  await settle();
  expect(texts(tree)).toContain(steps[0].title);
  expect(texts(tree)).toContain(`1 of ${steps.length}`);
  for (let i = 1; i < steps.length; i++) {
    await act(async () => press(tree, "Next"));
    await settle();
    expect(texts(tree)).toContain(steps[i].title);
    expect(texts(tree)).toContain(`${i + 1} of ${steps.length}`);
  }
  // The admin step links the dashboard, and the last button says Done.
  expect(texts(tree)).toContain("neopin.example.org");
  expect(texts(tree)).not.toContain("Skip");
  await act(async () => press(tree, "Done"));
  await settle();
  expect(onFinish).toHaveBeenCalledTimes(1);
  // Every control was measured once, the steps without one not at all.
  const measured = measure.mock.calls.map((call) => call[0]);
  expect(measured).toEqual(steps.map((s) => s.target).filter(Boolean));
});

test("Skip ends it at once", async () => {
  const onFinish = jest.fn();
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<Host isAdmin={false} measure={async () => null} onFinish={onFinish} />);
  });
  await settle();
  await act(async () => press(tree, "Skip the tour"));
  await settle();
  expect(onFinish).toHaveBeenCalledTimes(1);
});
