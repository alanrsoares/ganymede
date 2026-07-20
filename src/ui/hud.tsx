// Shared HUD chrome primitives — the game's on-canvas overlay look (signal-cyan
// hairline borders, translucent near-black surfaces, mono uppercase text). One
// source of truth so the scoreboard, controls, guide, and codex opener can't
// drift apart. astryx components are for dialog/codex interiors; the HUD wears
// this hand-styled chrome instead (astryx neutral defaults read off-brand here).
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

/** Brand palette — the only place these hexes live. */
export const HUD = {
  cyan: "#3fd8ff", // accent: borders, glow, selection
  ink: "#8fe6ff", // interactive/label text
  mint: "#d3f5e9", // heading text
  deep: "#040a0e", // surface base
} as const;

const cx = (...xs: (string | false | undefined)[]) =>
  xs.filter(Boolean).join(" ");

const PANEL_ACCENT = {
  cyan: "border-signal/20",
  amber: "border-gold/20",
} as const;

/** Translucent bordered overlay panel. Shared chrome (rounded, hairline border,
 *  mono, blur); caller supplies surface fill/text, position, and padding — their
 *  opacities vary per panel, so they stay on the className to avoid conflicts. */
export const HudPanel = ({
  accent = "cyan",
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { accent?: keyof typeof PANEL_ACCENT }) => (
  <div
    className={cx(
      "rounded-lg border font-mono backdrop-blur-[4px]",
      PANEL_ACCENT[accent],
      className,
    )}
    {...rest}
  >
    {children}
  </div>
);

/** Cyan hairline pill — HUD toggles and openers. Sizing (padding, text size,
 *  standalone background) is caller-supplied via className so a larger opener
 *  and a compact chevron toggle share one identity without utility conflicts. */
export const HudButton = ({
  className,
  children,
  type,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
  <button
    type={type ?? "button"}
    className={cx(
      "cursor-pointer rounded border border-signal/30 uppercase tracking-[0.1em] text-frost transition-colors [touch-action:manipulation] hover:bg-signal/10",
      className,
    )}
    {...rest}
  >
    {children}
  </button>
);
