import { $, mapErr, ok, type Result, tryGen } from "@onrails/result";
import type { Component, ComponentError } from "./component";
import type { Pulse } from "./pulses";

export interface Connection {
  readonly fromId: string;
  readonly fromChannel: string;
  readonly toId: string;
}

export interface CircuitState {
  // Heterogeneous per-component states; each Component<S> owns its own shape.
  readonly componentStates: Map<string, unknown>;
  readonly inFlightPulses: Pulse[];
  readonly currentTick: number;
}

export interface CircuitConfig {
  readonly components: Component<unknown>[];
  readonly connections: Connection[];
}

export type CircuitError =
  | {
      readonly _tag: "ComponentFailure";
      readonly id: string;
      readonly error: ComponentError;
    }
  | { readonly _tag: "RoutingError"; readonly message: string };

const componentFailure =
  (id: string) =>
  (error: ComponentError): CircuitError => ({
    _tag: "ComponentFailure",
    id,
    error,
  });

/**
 * Advances the simulation by one tick.
 */
export const step = (
  config: CircuitConfig,
  state: CircuitState,
): Result<{ nextState: CircuitState; emittedPulses: Pulse[] }, CircuitError> =>
  tryGen(() => {
    const nextComponentStates = new Map(state.componentStates);
    const currentTick = state.currentTick;

    // 1. Collect pulses arriving at this exact tick for each component
    const inputsForComponent = new Map<string, Pulse[]>();
    for (const comp of config.components) {
      inputsForComponent.set(comp.id, []);
    }

    const remainingPulses: Pulse[] = [];
    for (const pulse of state.inFlightPulses) {
      // A pulse emitted at tick T enters flight after routing has already run
      // for T, so it is delivered on the first step where timestamp <= tick.
      if (pulse.timestamp <= currentTick) {
        // Component ids may contain "-", so match the full channelId against
        // each connection's expected "<channel>-<componentId>" instead of
        // parsing the string.
        const connection = config.connections.find(
          (c) => pulse.channelId === `${c.fromChannel}-${c.fromId}`,
        );

        if (connection) {
          inputsForComponent.get(connection.toId)?.push(pulse);
        }
        // No route defined for this output: pulse vanishes.
      } else {
        remainingPulses.push(pulse);
      }
    }

    // 2. Transition each component
    const allNewPulses: Pulse[] = [];
    for (const comp of config.components) {
      const compState = state.componentStates.get(comp.id);
      const inputs = inputsForComponent.get(comp.id) ?? [];

      const [nextS, outputs] = $(
        mapErr(
          comp.transition(currentTick, compState, inputs),
          componentFailure(comp.id),
        ),
      );

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
  });
