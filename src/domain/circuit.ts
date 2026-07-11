import { $, mapErr, ok, type Result, tryGen } from "@onrails/result";
import type { Component, ComponentError } from "./component";
import type { Pulse } from "./pulses";

export interface Connection {
  readonly fromId: string;
  readonly fromChannel: string;
  readonly toId: string;
  /**
   * Input port on the receiving component. Delivered pulses have their
   * channelId rewritten to this, so components address inputs by port name
   * instead of relying on array position (which is unordered).
   */
  readonly toPort: string;
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
 * Splits in-flight pulses into those delivered this tick (grouped by
 * destination component, with channelId rewritten to the receiving port) and
 * those still in flight for a future tick.
 */
const routeIncomingPulses = (
  config: CircuitConfig,
  inFlightPulses: Pulse[],
  currentTick: number,
): { inputsForComponent: Map<string, Pulse[]>; remainingPulses: Pulse[] } => {
  const inputsForComponent = new Map<string, Pulse[]>();
  for (const comp of config.components) {
    inputsForComponent.set(comp.id, []);
  }

  const remainingPulses: Pulse[] = [];
  for (const pulse of inFlightPulses) {
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
        inputsForComponent
          .get(connection.toId)
          ?.push({ ...pulse, channelId: connection.toPort });
      }
      // No route defined for this output: pulse vanishes.
    } else {
      remainingPulses.push(pulse);
    }
  }

  return { inputsForComponent, remainingPulses };
};

/** Runs each component's transition function for this tick. */
const transitionComponents = (
  config: CircuitConfig,
  componentStates: Map<string, unknown>,
  inputsForComponent: Map<string, Pulse[]>,
  currentTick: number,
): Result<
  { nextComponentStates: Map<string, unknown>; allNewPulses: Pulse[] },
  CircuitError
> =>
  tryGen(() => {
    const nextComponentStates = new Map(componentStates);
    const allNewPulses: Pulse[] = [];

    for (const comp of config.components) {
      const compState = componentStates.get(comp.id);
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

    return ok({ nextComponentStates, allNewPulses });
  });

/**
 * Advances the simulation by one tick.
 */
export const step = (
  config: CircuitConfig,
  state: CircuitState,
): Result<{ nextState: CircuitState; emittedPulses: Pulse[] }, CircuitError> =>
  tryGen(() => {
    const currentTick = state.currentTick;

    // 1. Collect pulses arriving at this exact tick for each component
    const { inputsForComponent, remainingPulses } = routeIncomingPulses(
      config,
      state.inFlightPulses,
      currentTick,
    );

    // 2. Transition each component
    const { nextComponentStates, allNewPulses } = $(
      transitionComponents(
        config,
        state.componentStates,
        inputsForComponent,
        currentTick,
      ),
    );

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
