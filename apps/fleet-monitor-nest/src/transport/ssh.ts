// A whole capture gets this multiple of the connect timeout before the process
// is killed: connecting is only the first half of the budget, and the script
// still has to run and stream back. Named so callers that have to reason about
// how long a round can take can derive it rather than guess.
export const CAPTURE_FACTOR = 2
