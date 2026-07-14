// Audio mixer: a compact corner control that expands into per-bus faders
// (master / music / sfx) plus a mute toggle. Pure view over the imperative
// `Audio` port — every change calls straight through to it (which persists +
// smooths the gain). Matches the setup screen's neon-on-dark chrome.

import van, { type State } from "vanjs-core";
import type { Audio, Bus } from "./runtime/audio";

const { div, button, input, span } = van.tags;

const CYAN = "#3fd8ff";
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3fd8ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b0f]";

// One 0..100% fader row bound to a bus. `s` mirrors the live level (0..1).
const fader = (
  labelText: string,
  s: State<number>,
  onSet: (v: number) => void,
) =>
  div(
    { class: "grid grid-cols-[3rem_1fr_2.5rem] items-center gap-x-2" },
    span(
      { class: "text-[10px] uppercase tracking-[0.12em] opacity-70" },
      labelText,
    ),
    input({
      type: "range",
      min: 0,
      max: 100,
      step: 1,
      "aria-label": `${labelText} volume`,
      value: () => String(Math.round(s.val * 100)),
      class: `w-full cursor-pointer rounded-full outline-none [touch-action:manipulation] ${FOCUS_RING}`,
      style: `accent-color:${CYAN}`,
      oninput: (e: Event) => {
        onSet(Number((e.target as HTMLInputElement).value) / 100);
      },
    }),
    span(
      { class: "text-right text-[10px] tabular-nums opacity-55" },
      () => `${Math.round(s.val * 100)}`,
    ),
  );

// The mute toggle; goes pink when muted. `muted` mirrors the live engine state.
const muteButton = (muted: State<boolean>, audio: Audio) =>
  button(
    {
      type: "button",
      "aria-label": "Toggle mute",
      class: `rounded px-2 py-1 text-[10px] uppercase tracking-[0.12em] transition-colors ${FOCUS_RING}`,
      style: () =>
        muted.val
          ? "color:#ff6b8a;border:1px solid #ff6b8a55"
          : `color:${CYAN};border:1px solid ${CYAN}55`,
      onclick: () => {
        audio.toggleMute();
        muted.val = audio.getLevels().muted;
      },
    },
    () => (muted.val ? "🔇 Muted" : "🔊 Sound"),
  );

// The collapsed 🎚️ affordance; flips the panel open.
const mixerToggle = (open: State<boolean>) =>
  button(
    {
      type: "button",
      "aria-label": "Audio mixer",
      "aria-expanded": () => String(open.val),
      class: `h-9 w-9 self-end rounded-lg border-0 text-[16px] leading-none text-[#3fd8ff] backdrop-blur transition-colors ${FOCUS_RING}`,
      style: "background:#0b1220cc",
      onclick: () => {
        open.val = !open.val;
      },
    },
    "🎚️",
  );

export const mountMixer = (audio: Audio) => {
  const init = audio.getLevels();
  const open = van.state(false);
  const muted = van.state(init.muted);
  const master = van.state(init.master);
  const music = van.state(init.music);
  const sfx = van.state(init.sfx);
  const bind = (b: Bus, s: State<number>) => (v: number) => {
    s.val = v;
    audio.setLevel(b, v);
  };

  const panel = div(
    {
      class:
        "flex w-[220px] flex-col gap-2 rounded-lg border border-[#3fd8ff]/25 bg-[#050b0f]/85 p-3 text-[#dfffff] shadow-[0_8px_30px_rgba(0,0,0,0.5)] backdrop-blur",
      style: () => (open.val ? "" : "display:none"),
    },
    div(
      { class: "flex items-center justify-between" },
      span(
        { class: "text-[11px] font-semibold uppercase tracking-[0.16em]" },
        "Audio",
      ),
      div(
        { class: "flex items-center gap-1.5" },
        button(
          {
            type: "button",
            "aria-label": "Next track",
            title: "Next track (.)",
            class: `rounded px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[#3fd8ff] transition-colors hover:bg-[#3fd8ff]/10 ${FOCUS_RING}`,
            style: `border:1px solid ${CYAN}55`,
            onclick: () => audio.skip(),
          },
          "⏭ Next",
        ),
        muteButton(muted, audio),
      ),
    ),
    fader("Master", master, bind("master", master)),
    fader("Music", music, bind("music", music)),
    fader("SFX", sfx, bind("sfx", sfx)),
  );

  const root = div(
    {
      class:
        "hud-mixer fixed right-3 bottom-3 z-50 flex flex-col items-end gap-2",
    },
    panel,
    mixerToggle(open),
  );
  van.add(document.body, root);
};
