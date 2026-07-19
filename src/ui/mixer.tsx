// Audio mixer: a compact corner control that expands into per-bus faders
// (master / music / sfx) plus a mute toggle. Pure view over the imperative
// `Audio` port — every change calls straight through to it (which persists +
// smooths the gain). Built on the Astryx design system, matching the dialogs.

import { IconButton } from "@astryxdesign/core/IconButton";
import { Section } from "@astryxdesign/core/Section";
import { Slider } from "@astryxdesign/core/Slider";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { useState } from "react";
import type { Audio, Bus } from "~/runtime/audio";
import { mountReactDialog } from "./dialog";

const pct = (v: number) => `${Math.round(v * 100)}`;

const BUSES: readonly { bus: Bus; label: string }[] = [
  { bus: "master", label: "Master" },
  { bus: "music", label: "Music" },
  { bus: "sfx", label: "SFX" },
];

const Mixer = ({ audio }: { audio: Audio }) => {
  const init = audio.getLevels();
  const [open, setOpen] = useState(false);
  const [muted, setMuted] = useState(init.muted);
  const [levels, setLevels] = useState<Record<Bus, number>>({
    master: init.master,
    music: init.music,
    sfx: init.sfx,
  });

  const setBus = (bus: Bus) => (v: number) => {
    setLevels((l) => ({ ...l, [bus]: v }));
    audio.setLevel(bus, v);
  };
  const onMute = () => {
    audio.toggleMute();
    setMuted(audio.getLevels().muted);
  };

  return (
    <div className="hud-mixer fixed right-3 bottom-3 z-50 flex flex-col items-end gap-2">
      {open && (
        <Section variant="section" padding={3} width={240}>
          <VStack gap={2}>
            <HStack justify="between" vAlign="center">
              <Text size="xsm" weight="semibold">
                Audio
              </Text>
              <HStack gap={1} vAlign="center">
                <IconButton
                  icon="⏭"
                  label="Next track"
                  tooltip="Next track (.)"
                  size="sm"
                  variant="ghost"
                  onClick={() => audio.skip()}
                />
                <ToggleButton
                  label={muted ? "Muted" : "Sound"}
                  icon={muted ? "🔇" : "🔊"}
                  isPressed={muted}
                  onPressedChange={onMute}
                  size="sm"
                />
              </HStack>
            </HStack>
            {BUSES.map(({ bus, label }) => (
              <Slider
                key={bus}
                label={label}
                min={0}
                max={1}
                step={0.01}
                value={levels[bus]}
                onChange={setBus(bus)}
                formatValue={pct}
              />
            ))}
          </VStack>
        </Section>
      )}
      <IconButton
        icon="🎚️"
        label="Audio mixer"
        variant="secondary"
        onClick={() => setOpen((o) => !o)}
      />
    </div>
  );
};

export const mountMixer = (audio: Audio): void =>
  mountReactDialog(<Mixer audio={audio} />);
