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

/**
 * Micro-label that opens a section; owns the section's top rhythm. The
 * trailing hairline makes it read as structure (a labeled rule), so it
 * can't be confused with the subtitle a few pixels above it.
 */
export const sectionHeading = (text: string): HTMLElement =>
  div(
    { class: "mt-7 mb-2.5 flex items-center gap-3" },
    h2(
      {
        class:
          "shrink-0 text-[10px] font-semibold uppercase tracking-[0.28em] text-muted",
      },
      text,
    ),
    div({ class: "h-px flex-1 bg-line", "aria-hidden": "true" }),
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
      { class: "flex items-center justify-between gap-4" },
      h1(
        {
          class:
            "text-[22px] font-black uppercase leading-none tracking-[0.16em] text-ink",
        },
        spec.title,
      ),
      button(
        {
          type: "button",
          "aria-label": "Close",
          class: `grid size-6 shrink-0 place-items-center rounded-md border border-line text-[11px] leading-none text-muted transition-colors hover:border-line-strong hover:text-ink ${FOCUS_RING}`,
          onclick: spec.onClose,
        },
        "✕",
      ),
    ),
    p(
      {
        class:
          "mt-3 max-w-[44ch] text-[12px] leading-relaxed text-muted [text-wrap:pretty]",
      },
      spec.subtitle,
    ),
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
  // Escape must close regardless of where focus sits (clicking the veil or
  // the sim leaves focus on <body>, outside the root's own key handler).
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape" && open.val) {
      e.stopPropagation();
      onClose();
    }
  });
  const root: HTMLElement = div(
    {
      class: () =>
        `absolute inset-0 z-40 place-items-center bg-veil p-6 font-mono text-ink backdrop-blur-[6px] ${open.val ? "grid" : "hidden"}`,
      onkeydown: (e: KeyboardEvent) => trapTab(root, e),
      onclick: (e: MouseEvent) => {
        if (e.target === root) onClose();
      },
    },
    panelEl,
  );
  return root;
};

/**
 * Land focus on the dialog's current selection (or its first real control) —
 * never the close button, which is first in the DOM but the least likely
 * intent, and Enter there would dismiss the dialog.
 */
export const focusDefault = (panel: HTMLElement): void => {
  // Deferred a frame: VanJS batches state updates, so at show() time the
  // dialog root is still display:none and .focus() would silently no-op.
  requestAnimationFrame(() => {
    const target =
      panel.querySelector<HTMLElement>('button[aria-pressed="true"]') ??
      panel.querySelector<HTMLElement>('button:not([aria-label="Close"])');
    if (target) target.focus();
    else focusFirst(panel);
  });
};

export { focusFirst };
