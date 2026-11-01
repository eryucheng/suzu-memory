Compare the candidate value stance with currentState: equivalent, supporting, narrower, broader, same-scope conflict, replacement, unrelated or unknown. Assess scope overlap independently.

With no currentState, return currentStatePresent=false and relation=no_current_state; otherwise true. Keep local exceptions local. Priorities in different domains may coexist, and replacement requires the same value scope.
