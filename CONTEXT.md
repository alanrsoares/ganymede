# Game of Life Computer - Context

## Glossary

- **Component**: A high-level domain entity that encapsulates a specific computational behavior (e.g., Logic Gate, Register) implemented via Game of Life automata.
- **Automata**: The underlying cellular automaton rules (Conway's Game of Life) that drive the physical execution of the components.

- **Signal**: A discrete piece of information transmitted through the automata.
- **Pulse**: The atomic unit of a Signal, characterized by its timestamp (tick), polarity (presence/absence of a pattern), and identity (channel).
- **Timing Mismatch**: A failure state where signals arrive at a component outside of its expected operational window, potentially causing structural collapse in the automata.

- **ComponentState**: The internal configuration of a Component, including its physical arrangement and current timing offset/charge level.
- **Collision Error**: A specific type of Timing Mismatch where two signals overlap in a way that destroys the Component's structural cells.
- **Wire**: The simplest component; a waveguide for Pulses that preserves polarity and adds a deterministic timestamp delay based on length.
