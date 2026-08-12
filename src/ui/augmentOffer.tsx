// Wave-clear augment offer: a forced-choice Astryx dialog that surfaces the 3
// augments the sim rolled, raised whenever `world.arcade.offer` is non-null. The
// render loop freezes the frozen field behind it (see main.ts: the offer feeds
// the sim-freeze predicate) and pushes the live offer into this module's store
// each frame; picking one dispatches `pickAugment`, which clears the offer and
// un-freezes. No dismiss affordance — you must choose.

import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { useSyncExternalStore } from "react";
import { AUGMENTS, type AugmentId, type AugmentStat } from "~/world/augments";
import { ChoiceCard, mountReactDialog } from "./dialog";

export interface AugmentOffer {
  /** Push the sim's current offer (or null) into the dialog each frame. */
  sync: (offer: readonly AugmentId[] | null) => void;
}

interface OfferStore {
  get: () => readonly AugmentId[] | null;
  subscribe: (cb: () => void) => () => void;
  set: (offer: readonly AugmentId[] | null) => void;
}

const createOfferStore = (): OfferStore => {
  let current: readonly AugmentId[] | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => current,
    subscribe: (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    // Identity-compare: the frozen sim hands back the same array each frame, so
    // this only emits on a real change (offer appears, or clears to null).
    set: (offer) => {
      if (offer === current) return;
      current = offer;
      for (const cb of subs) cb();
    },
  };
};

// Card accent by what the augment does — defense cyan, offense amber, mobility
// lime — so the three choices read apart at a glance. `satisfies` keeps this
// exhaustive: a new AugmentStat in the sim fails the build here until tinted.
const STAT_TINT = {
  hp: "var(--color-accent)",
  shield: "var(--color-accent)",
  regen: "#34d399",
  damage: "#f59e0b",
  cooldown: "#f59e0b",
  speed: "#a3e635",
} satisfies Record<AugmentStat, string>;

const OfferView = ({
  store,
  onPick,
}: {
  store: OfferStore;
  onPick: (id: AugmentId) => void;
}) => {
  const offer = useSyncExternalStore(store.subscribe, store.get);
  const open = offer !== null && offer.length > 0;
  return (
    <Dialog
      isOpen={open}
      // Forced choice: swallow Escape / backdrop dismiss, the pick is the only exit.
      onOpenChange={() => {}}
      width="min(480px, 92vw)"
      maxHeight="90dvh"
      purpose="info"
      aria-label="Choose an augment"
    >
      <DialogHeader
        title="Wave cleared"
        subtitle="Choose one. It lasts until the run ends."
      />
      <div className="-mx-1 flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto px-1 py-1">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(offer ?? []).map((id) => {
            const spec = AUGMENTS[id];
            return (
              <ChoiceCard
                key={id}
                title={spec.label}
                blurb={spec.blurb}
                pressed={false}
                tint={spec.stat ? STAT_TINT[spec.stat] : undefined}
                onClick={() => onPick(id)}
              />
            );
          })}
        </div>
      </div>
    </Dialog>
  );
};

export const mountAugmentOffer = (
  onPick: (id: AugmentId) => void,
): AugmentOffer => {
  const store = createOfferStore();
  mountReactDialog(<OfferView store={store} onPick={onPick} />);
  return { sync: (offer) => store.set(offer) };
};
