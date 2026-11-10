---
description: "State machine gate for code: a thing that moves through named states keeps its states and moves in one typed place"
---

# State machine gate

When code tracks something that moves through a fixed set of states, such as a lifecycle, a status, a connection or a request, make its states and the moves between them explicit:

1. One list of the states: a union type or an `as const` list (an `Enum` or `Literal` in Python), defined once and imported. Never the same string list in two files.
2. One owner for the moves: a table (each event or state and the states it allows) or one function that derives the state. Callers ask the owner; they never derive the state again from flags.
3. No set of booleans and nullables that can stand for a state the product does not have. `loading`, `error` and `data` as three fields become one union. A `connected` boolean that hides `connecting` and `reconnecting` becomes named states.
4. A refusal names the current state and what would allow the action: the missing step, or the states that allow it. A person or an agent can act on it without reading the code.
5. Write a rule the table does not show next to its definition: a state that is only derived, a flag that latches, an order of precedence.

Keep it small:

- Use the language's own types and a plain object. Add no state machine library and no framework for one machine.
- A state value that is stored or printed (an event log, a state file, API JSON, CLI output) is a contract. Making it explicit never renames it; a rename is its own change, with a migration.
- A plain on and off is not a machine. Leave a boolean that has two meaningful values.

In Ark, `cli/lifecycle.ts` holds the run's `phases`, the transition table `eventPhases`, `gateAnswers` and `gateAnswerPhases`, and `cli/transitions.ts` checks them.
