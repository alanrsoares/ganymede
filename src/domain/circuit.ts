import { err, ok, type Result } from "@onrails/result";
import type { Component, ComponentError } from "./component";
import type { Pulse } from "./pulses";

export interface Connection {
  readonly fromId: string;
  readonly fromChannel: string;
  readonly toId: string;
}

export interface CircuitState {
  readonly componentStates: Map<string, any>;
  readonly inFlightPulses: Pulse[];
  readonly currentTick: number;
}

export interface CircuitConfig<C extends Component<any>> {
  readonly components: C[];
  readonly connections: Connection[];
}

export type CircuitError =
  | {
      readonly _tag: "ComponentFailure";
      readonly id: string;
      readonly error: ComponentError;
    }
  | { readonly _tag: "RoutingError"; readonly message: string };

/**
 * Advances the simulation by one tick.
 */
export const step = <C extends Component<any>>(
  config: CircuitConfig<C>,
  state: CircuitState,
): Result<
  { nextState: CircuitState; emittedPulses: Pulse[] },
  CircuitError
> => {
  const nextComponentStates = new Map(state.componentStates);
  const currentTick = state.currentTick;

  // 1. Collect pulses arriving at this exact tick for each component
  const inputsForComponent = new Map<string, Pulse[]>();
  for (const comp of config.components) {
    inputsForComponent.set(comp.id, []);
  }

  const remainingPulses: Pulse[] = [];
  for (const pulse of state.inFlightPulses) {
    if (pulse.timestamp === currentTick) {
      // Expected format "out-componentId"
      const parts = pulse.channelId.split("-");
      if (parts.length < 2) {
        remainingPulses.push(pulse);
        continue;
      }
      const [channel, id] = parts;

      const connection = config.connections.find(
        (c) => c.fromId === id && c.fromChannel === channel,
      );

      if (connection) {
        inputsForComponent.get(connection.toId)?.push(pulse);
      } else {
        // Pulse vanished - no route defined for this output
      }
    } else if (pulse.timestamp > currentTick) {
      remainingPulses.push(pulse);
    }
  }

  // 2. Transition each component
  const allNewPulses: Pulse[] = [];
  for (const comp of config.components) {
    const compState = state.componentStates.get(comp.id);
    const inputs = inputsForComponent.get(comp.id) ?? [];

    const result = comp.transition(currentTick, compState, inputs);

    if (result._tag === "Err") {
      return err({
        _tag: "ComponentFailure",
        id: comp.id,
        error: result.error,
      });
    }

    const [nextS, outputs] = result.value;
    nextComponentStates.set(comp.id, nextS);
    allNewPulses.push(...outputs);
  }

  // 3. Update in-flight pulses (future ones + newly emitted)
  const nextInFlight = [...remainingPulses, ...allNewPulses];

  return ok({
    nextState: {
      componentStates: nextComponentStates,
      inFlightPulses: nextInFlight,
      currentTick: currentTick + 1,
    },
    emittedPulses: allNewPulses,
  });
};
