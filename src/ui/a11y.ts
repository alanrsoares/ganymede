// Tiny focus helpers for the modal overlays (setup screen, ship codex): find
// the tabbable controls inside a container, move focus in when it opens, and
// keep Tab from escaping while it's up. Pure DOM, no framework coupling.

const FOCUSABLE =
  'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])';

// Visible, tabbable descendants in DOM order. `offsetParent === null` filters
// out anything in a `display:none` subtree (e.g. a collapsed panel).
export const focusables = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null,
  );

// Move focus to the first control once layout settles (the container may have
// been `display:none` up to this tick).
export const focusFirst = (root: HTMLElement): void => {
  queueMicrotask(() => focusables(root)[0]?.focus());
};

// Wrap Tab / Shift+Tab at the container's edges so focus stays inside. Self-
// guards on the Tab key, so callers can hand it every keydown.
export const trapTab = (root: HTMLElement, e: KeyboardEvent): void => {
  if (e.key !== "Tab") return;
  const items = focusables(root);
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && active === first) {
    last.focus();
    e.preventDefault();
  } else if (!e.shiftKey && active === last) {
    first.focus();
    e.preventDefault();
  }
};
