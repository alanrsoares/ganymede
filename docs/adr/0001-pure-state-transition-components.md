# ADR 0001: Pure State Transition Model for Components

## Status
Superseded (2026-07) — the repo pivoted to a roguelike autobattler under
`src/web`. The Game-of-Life computer, its components (`src/components`), and
domain model (`src/domain`) have been removed. This ADR is retained as a
historical record of the original design. See `CONTEXT.md`.

## Context
We are building a Turing-complete computer inside Conway's Game of Life (GoL). GoL is inherently a stateful cellular automaton, but we want to model the high-level components (Gates, Registers) using functional DDD principles. We need a way to represent how these components process signals over time while accounting for "physical" failures like structural collapse due to timing mismatches.

## Decision
We will model every component as a pure state transition function:
`(state: ComponentState, inputs: Pulse[]) => Result<(nextState: ComponentState, outputs: Pulse[]), ComponentError>`

- **Pure Functions**: All logic is deterministic and devoid of side effects.
- **Explicit Error Handling**: We use `@onrails/result` to handle failures (e.g., `TimingMismatch`, `CollisionError`) as first-class values rather than throwing exceptions.
- **State Encapsulation**: The state represents the internal "physics" of the component (current pulse offsets, charge levels).

## Consequences
- **Pros**: 
    - Highly testable; we can property-test specific components by feeding them a sequence of pulses.
    - Naturally mirrors the discrete tick-based nature of cellular automata.
    - Forces explicit handling of "physical" failures in the simulation.
- **Cons**: 
    - State management becomes an external concern (the "Grid" or "System" must manage and pass the state back to the component).
