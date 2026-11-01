Compare the candidate identity fact with currentState in the fixed representation layer: equivalent, supporting, an additional value, changed value, narrower or broader scope, ended, same-scope conflict, unrelated or unknown. Assess value overlap independently.

With no currentState, return currentStatePresent=false and relation=no_current_state; otherwise return true. For fieldCardinality single/sequence an explicit current value change may be value_changed; for multi_item a new item is additional_value. Addition alone does not end an older item.
