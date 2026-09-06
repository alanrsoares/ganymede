// Graphics settings: the player-facing face of `render/quality.ts`. A five-way
// segmented control (Auto + the four tiers) plus a live readout of what Auto
// currently resolves to and how fast frames are landing.
//
// Rendered twice: in the corner settings panel (the only route into it from the
// attract screen / lobby, where ESC does nothing) and inside the pause menu.
// Both are pure views over the imperative `QualityStore` — every change calls
// straight through, and the store persists.

import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useState, useSyncExternalStore } from "react";
import { MODES, type QualityMode, type QualityStore } from "~/render/quality";

const LABELS: Record<QualityMode, string> = {
  auto: "Auto",
  low: "Low",
  medium: "Med",
  high: "High",
  ultra: "Ultra",
};

/** What each tier actually buys, so the choice isn't a guess. */
const BLURB: Record<QualityMode, string> = {
  auto: "Follows the frame rate.",
  low: "Half-res, no bloom, no plumes.",
  medium: "Reduced res, cheap bloom.",
  high: "Full res, full bloom.",
  ultra: "Full res, wide bloom, 3x DPR.",
};

export interface GraphicsPanelProps {
  quality: QualityStore;
  /** Smoothed frame time in ms from the governor; NaN before warm-up. */
  frameMs?: () => number;
}

/** Live smoothed frame time, sampled twice a second while the panel is open. */
const useFrameMs = (read?: () => number): number => {
  const [ms, setMs] = useState(() => read?.() ?? Number.NaN);
  useEffect(() => {
    if (!read) return;
    const id = setInterval(() => setMs(read()), 500);
    return () => clearInterval(id);
  }, [read]);
  return ms;
};

export const GraphicsSettings = ({ quality, frameMs }: GraphicsPanelProps) => {
  // The governor moves the effective tier behind React's back, so subscribe to
  // the store rather than mirroring it in state.
  const tier = useSyncExternalStore(quality.subscribe, quality.tier);
  const [mode, setMode] = useState<QualityMode>(quality.mode);
  const ms = useFrameMs(frameMs);

  const pick = (next: string) => {
    quality.setMode(next as QualityMode);
    setMode(next as QualityMode);
  };

  const fps = Number.isFinite(ms) ? ` · ${Math.round(1000 / ms)} fps` : "";
  return (
    <VStack gap={2}>
      <SegmentedControl
        value={mode}
        onChange={pick}
        label="Graphics quality"
        size="sm"
        layout="fill"
      >
        {MODES.map((m) => (
          <SegmentedControlItem key={m} value={m} label={LABELS[m]} />
        ))}
      </SegmentedControl>
      <Text size="xsm" color="secondary">
        {mode === "auto" ? `Auto → ${LABELS[tier]}` : BLURB[mode]}
        {fps}
      </Text>
    </VStack>
  );
};
