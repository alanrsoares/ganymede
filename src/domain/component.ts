import type { Result } from "@onrails/result";
import type { Pulse, TimingError } from "./pulses";

export type ComponentError =
  | TimingError
  | { readonly _tag: "StructuralCollapse"; readonly reason: string };

export interface Component<S> {
  readonly id: string;
  // Method syntax (bivariant) so Component<ConcreteState> is assignable to
  // Component<unknown> where the circuit stores heterogeneous components.
  transition(
    tick: number,
    state: S,
    inputs: Pulse[],
  ): Result<[S, Pulse[]], ComponentError>;
}
