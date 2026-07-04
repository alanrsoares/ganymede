import type { Result } from "@onrails/result";
import type { Pulse, TimingError } from "./pulses";

export type ComponentError =
  | TimingError
  | { readonly _tag: "StructuralCollapse"; readonly reason: string };

export interface Component<S> {
  readonly id: string;
  readonly transition: (
    tick: number,
    state: S,
    inputs: Pulse[],
  ) => Result<[S, Pulse[]], ComponentError>;
}
