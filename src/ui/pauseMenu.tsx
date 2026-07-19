// Desktop pause menu: an Astryx dialog overlay raised with ESC mid-match. The
// render loop keeps drawing the frozen world behind the veil (see `wirePause`
// in main.ts, which ORs this store's `isOpen()` into the sim-freeze predicate),
// so this module only owns the menu chrome. The keyboard equivalent of the
// touch pause button (`makePauseButton`, src/ui/mobileControls.ts).

import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/Stack";
import {
  Cta,
  createDialogStore,
  DialogShell,
  type DialogStore,
  mountReactDialog,
} from "./dialog";

export interface PauseMenu {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
}

export interface PauseMenuOpts {
  /** Restart the current match from the start (same config). */
  onRestart: () => void;
  /** Abandon the match and return to the title splash. */
  onQuit: () => void;
}

const PauseView = ({
  store,
  onRestart,
  onQuit,
}: {
  store: DialogStore;
  onRestart: () => void;
  onQuit: () => void;
}) => {
  const resume = () => store.close();
  const restart = () => {
    store.close();
    onRestart();
  };
  const quit = () => {
    store.close();
    onQuit();
  };
  return (
    <DialogShell
      store={store}
      label="Game paused"
      title="Paused"
      subtitle="The battle is frozen. Press ESC to resume."
      // Backdrop click / ✕ dismiss resumes; ESC is owned by the input layer.
      onClose={resume}
    >
      <VStack gap={2}>
        <Cta label="Resume" onClick={resume} />
        <Button
          variant="secondary"
          size="lg"
          label="Restart game"
          onClick={restart}
          className="w-full"
        />
        <Button
          variant="secondary"
          size="lg"
          label="Quit to title"
          onClick={quit}
          className="w-full"
        />
      </VStack>
    </DialogShell>
  );
};

export const mountPauseMenu = (opts: PauseMenuOpts): PauseMenu => {
  const store = createDialogStore(false);
  mountReactDialog(
    <PauseView store={store} onRestart={opts.onRestart} onQuit={opts.onQuit} />,
  );
  return {
    open: () => store.open(),
    close: () => store.close(),
    toggle: () => (store.isOpen() ? store.close() : store.open()),
    isOpen: () => store.isOpen(),
  };
};
