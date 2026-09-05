// Shared React chrome for the pre-game dialogs (arcade lobby + autobattle
// setup). Built entirely on the Astryx design system — `Dialog` shell, labeled
// `Divider` section rules, `SelectableCard` option grid, `Button` action — so
// both panels re-skin with the theme and match the drydock chrome. The only
// game-specific glue is the open-state store bridging the imperative game loop
// to React.
//
// Astryx components render into the game's index.html, which only pulls the
// Astryx *token* layer, so this module pulls the full component stylesheet.

import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { SelectableCard } from "@astryxdesign/core/SelectableCard";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { CSSProperties, ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AstryxRoot } from "~/astryx";

// A dialog's open-state lives in a framework-agnostic store: the game loop
// reads it synchronously (`isOpen()` gates sim freeze) and drives it
// imperatively (`show`/`hide`), while React subscribes via
// `useSyncExternalStore`. Mirrors the drydock store bridge.
export interface DialogStore {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  subscribe: (cb: () => void) => () => void;
}

export const createDialogStore = (initial: boolean): DialogStore => {
  let open = initial;
  const subs = new Set<() => void>();
  const emit = () => {
    for (const cb of subs) cb();
  };
  return {
    open: () => {
      if (!open) {
        open = true;
        emit();
      }
    },
    close: () => {
      if (open) {
        open = false;
        emit();
      }
    },
    isOpen: () => open,
    subscribe: (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
};

/** Subscribe a React tree to a dialog's open state. */
export const useDialogOpen = (store: DialogStore): boolean =>
  useSyncExternalStore(store.subscribe, store.isOpen);

/**
 * Append a container to <body> and render the dialog tree into its own root,
 * wrapped in the shared Astryx theme so its components resolve the design
 * tokens (accent fill, surfaces) — same wrapper drydock uses.
 */
export const mountReactDialog = (node: ReactNode): void => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(<AstryxRoot>{node}</AstryxRoot>);
};

/** Micro-label that opens a section — a labeled hairline rule. */
export const SectionHeading = ({ children }: { children: string }) => (
  <Divider label={children} />
);

export interface ChoiceCardProps {
  title: string;
  blurb: string;
  pressed: boolean;
  onClick: () => void;
  /** Per-option accent (e.g. a class tint); defaults to the theme accent. */
  tint?: string;
  /** Optional leading glyph (e.g. a hull silhouette). */
  icon?: ReactNode;
}

// Accent-tinted translucency (game cyan / drydock green, or a per-card `tint`),
// mixed in OKLab. Inline (not a stylesheet rule) on purpose: Bun's CSS bundler
// downlevels color-mix() in a property to a solid fallback, but leaves inline
// styles alone.
const tintMix = (base: string, pct: number) =>
  `color-mix(in oklab, ${base} ${pct}%, transparent)`;

/**
 * One selectable option, styled as the welcome-screen mode CTA: a translucent
 * accent fill over a thin accent hairline, brighter (with an accent glow) when
 * chosen. The fills live in the inline `style`; the utility classes suppress
 * astryx's built-in ::after hover wash (`after:!bg-transparent` — the `!` beats
 * astryx's stylex specificity) and add a plain accent glow on hover. Keeps
 * `SelectableCard` for its radio a11y. Single-select grids, so we ignore
 * deselect and let the parent set the value.
 */
export const ChoiceCard = ({
  title,
  blurb,
  pressed,
  onClick,
  tint,
  icon,
}: ChoiceCardProps) => {
  const base = tint ?? "var(--color-accent)";
  const text = (
    <VStack gap={0.5} className="min-w-0 flex-1">
      <Text
        size="sm"
        weight="bold"
        display="block"
        className="truncate uppercase tracking-[0.06em] text-[11px] sm:text-xs"
      >
        {title}
      </Text>
      <Text
        color="secondary"
        display="block"
        className="line-clamp-2 leading-snug text-[9px]! sm:text-[10px]!"
      >
        {blurb}
      </Text>
    </VStack>
  );
  return (
    <SelectableCard
      label={title}
      isSelected={pressed}
      onChange={() => onClick()}
      padding={2}
      className="transition-shadow after:!bg-transparent hover:shadow-[0_0_14px_-4px_var(--card-glow)] !p-2 sm:!p-2.5"
      style={
        {
          "--card-glow": base,
          border: `1px solid ${tintMix(base, pressed ? 66 : 32)}`,
          background: tintMix(base, pressed ? 20 : 8),
          boxShadow: pressed ? `0 0 18px -3px ${base}` : undefined,
        } as CSSProperties
      }
    >
      {icon ? (
        <HStack gap={1.5} vAlign="center" className="min-w-0">
          {icon}
          {text}
        </HStack>
      ) : (
        text
      )}
    </SelectableCard>
  );
};

/** The one filled element in the dialog — the launch action. */
export const Cta = ({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) => (
  <Button
    variant="primary"
    size="lg"
    label={label}
    onClick={onClick}
    className="mt-3 w-full"
  />
);

export interface DialogShellProps {
  store: DialogStore;
  /** aria-label for the dialog. */
  label: string;
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Panel shell on Astryx `Dialog`: veil + blur over the live sim, focus trap,
 * Escape and backdrop-click close (purpose="info"). `store` drives visibility;
 * closing via ✕ / Escape / backdrop routes through `onClose`.
 */
export const DialogShell = ({
  store,
  label,
  title,
  subtitle,
  onClose,
  children,
}: DialogShellProps) => {
  const open = useDialogOpen(store);
  const requestClose = (next: boolean) => {
    if (!next) onClose();
  };
  return (
    <Dialog
      isOpen={open}
      onOpenChange={requestClose}
      width="min(440px, 92vw)"
      maxHeight="90dvh"
      purpose="info"
      aria-label={label}
    >
      <DialogHeader
        title={title}
        subtitle={subtitle}
        onOpenChange={requestClose}
      />
      <div className="-mx-1 flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto px-1 py-1 outline-none focus:outline-none focus-visible:outline-none">
        {children}
      </div>
    </Dialog>
  );
};
