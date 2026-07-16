// Shared chrome for the pre-game dialogs (arcade lobby + autobattle setup).
// One vocabulary, token-driven: every color comes through the Astryx→Tailwind
// bridge in styles.css (surface/card/line/ink/muted/signal/veil), so both
// panels re-skin together on a theme swap and the signal cyan is spent only
// on selection and the primary action.

import van, { type State } from "vanjs-core";
import { focusFirst, trapTab } from "./a11y";

const { div, h1, h2, span, button, p } = van.tags;

export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

/** Micro-label that opens a section; owns the section's top rhythm. */
export const sectionHeading = (text: string): HTMLElement =>
  h2(
    {
      class:
        "mt-6 mb-2 text-[10px] font-semibold uppercase tracking-[0.28em] text-muted",
    },
    text,
  );

export interface ChoiceCardSpec {
  title: string;
  blurb: string;
  pressed: () => boolean;
  onclick: () => void;
}

/**
 * Selectable option card. Resting state is neutral (card surface, hairline);
 * the signal accent appears only when selected, so a grid of options reads
 * as one quiet group with a single lit choice.
 */
export const choiceCard = (spec: ChoiceCardSpec): HTMLElement =>
  button(
    {
      type: "button",
      "aria-pressed": () => String(spec.pressed()),
      class: () =>
        "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors " +
        FOCUS_RING +
        (spec.pressed()
          ? " border-signal bg-signal/15 text-ink"
          : " border-line bg-card/40 text-ink hover:border-line-strong hover:bg-card"),
      onclick: spec.onclick,
    },
    span(
      { class: "text-[12px] font-semibold uppercase tracking-[0.1em]" },
      spec.title,
    ),
    span({ class: "text-[10px] text-muted" }, spec.blurb),
  );

/** The one filled element in the dialog — the launch action. */
export const ctaButton = (text: string, onclick: () => void): HTMLElement =>
  button(
    {
      type: "button",
      class: `mt-7 w-full cursor-pointer rounded-xl bg-signal py-3 text-[13px] font-bold uppercase tracking-[0.16em] text-surface transition-colors hover:bg-signal/85 ${FOCUS_RING}`,
      onclick,
    },
    text,
  );

export interface DialogSpec {
  /** aria-label for the dialog. */
  label: string;
  title: string;
  subtitle: string;
  onClose: () => void;
}

/**
 * Panel shell: title row with a close button, muted subtitle, then content.
 * Sections inside should start with `sectionHeading`.
 */
export const dialogPanel = (
  spec: DialogSpec,
  ...children: readonly HTMLElement[]
): HTMLElement =>
  div(
    {
      role: "dialog",
      "aria-modal": "true",
      "aria-label": spec.label,
      class:
        "w-full max-w-[440px] max-h-[90dvh] overflow-y-auto overscroll-contain rounded-2xl border border-line bg-surface/95 p-6 shadow-[0_20px_60px_-20px_#000]",
    },
    div(
      { class: "flex items-start justify-between gap-4" },
      h1(
        {
          class: "text-[20px] font-bold uppercase tracking-[0.14em] text-ink",
        },
        spec.title,
      ),
      button(
        {
          type: "button",
          "aria-label": "Close",
          class: `-mr-1 -mt-1 rounded-md border border-line px-2 py-0.5 text-[12px] text-muted transition-colors hover:border-line-strong hover:text-ink ${FOCUS_RING}`,
          onclick: spec.onClose,
        },
        "✕",
      ),
    ),
    p({ class: "mt-1 text-[11px] text-muted" }, spec.subtitle),
    ...children,
  );

/**
 * Modal root: veil + blur over the live sim, tab trap, Escape and
 * backdrop-click close. `open` drives visibility reactively.
 */
export const dialogRoot = (
  open: State<boolean>,
  panelEl: HTMLElement,
  onClose: () => void,
): HTMLElement => {
  const root: HTMLElement = div(
    {
      class: () =>
        `absolute inset-0 z-40 place-items-center bg-veil p-6 font-mono text-ink backdrop-blur-[6px] ${open.val ? "grid" : "hidden"}`,
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          return;
        }
        trapTab(root, e);
      },
      onclick: (e: MouseEvent) => {
        if (e.target === root) onClose();
      },
    },
    panelEl,
  );
  return root;
};

export { focusFirst };
