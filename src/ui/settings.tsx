// The HUD settings cluster: one corner button that opens one panel holding both
// the audio mixer and the graphics tier picker. They used to be two stacked
// popovers fighting for the bottom-right corner (and, on a phone, for the same
// safe-area gutter) — one button, one surface, two labelled sections.

import { Divider } from "@astryxdesign/core/Divider";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Section } from "@astryxdesign/core/Section";
import { VStack } from "@astryxdesign/core/Stack";
import { useState } from "react";
import type { Audio } from "~/runtime/audio";
import { mountReactDialog } from "./dialog";
import type { GraphicsPanelProps } from "./graphics";
import { GraphicsSettings } from "./graphics";
import { AudioSettings } from "./mixer";

export interface SettingsPanelProps extends GraphicsPanelProps {
  audio: Audio;
}

const SettingsPanel = ({ audio, quality, frameMs }: SettingsPanelProps) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="hud-settings fixed right-3 bottom-3 z-50 flex flex-col items-end gap-2">
      {open && (
        <Section variant="section" padding={3} width={330}>
          <VStack gap={2}>
            <AudioSettings audio={audio} />
            <Divider label="Graphics" />
            <GraphicsSettings quality={quality} frameMs={frameMs} />
          </VStack>
        </Section>
      )}
      <IconButton
        icon="🎚️"
        label="Settings"
        variant="secondary"
        onClick={() => setOpen((o) => !o)}
      />
    </div>
  );
};

export const mountSettings = (props: SettingsPanelProps): void =>
  mountReactDialog(<SettingsPanel {...props} />);
