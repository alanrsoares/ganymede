export interface InteractionState {
  takenPickups: Set<number>;
  removedMines: Set<number>;
}

export const createInteractionState = (): InteractionState => ({
  takenPickups: new Set<number>(),
  removedMines: new Set<number>(),
});
