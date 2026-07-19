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
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";
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

const useDialogOpen = (store: DialogStore): boolean =>
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
}

/**
 * One selectable option. `SelectableCard` owns the card chrome, selection ring
 * and a11y; the grids are single-select, so we ignore deselect and let the
 * parent set the chosen value.
 */
export const ChoiceCard = ({
  title,
  blurb,
  pressed,
  onClick,
}: ChoiceCardProps) => (
  <SelectableCard
    label={title}
    isSelected={pressed}
    onChange={() => onClick()}
    padding={2}
  >
    <VStack gap={0.5}>
      <Text size="sm" weight="semibold" display="block">
        {title}
      </Text>
      <Text size="2xs" color="secondary" display="block">
        {blurb}
      </Text>
    </VStack>
  </SelectableCard>
);

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
    className="mt-6 w-full"
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
      width={440}
      maxHeight="90dvh"
      purpose="info"
      aria-label={label}
    >
      <DialogHeader
        title={title}
        subtitle={subtitle}
        onOpenChange={requestClose}
      />
      {children}
    </Dialog>
  );
};
