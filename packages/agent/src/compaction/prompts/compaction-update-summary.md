Update the existing handover notes in <previous-summary> tags from new messages above, keeping the assistant's first-person voice ("I" = the assistant), for the assistant's next instance to resume.

MUST:
- preserve all previous-summary information; add new progress, decisions, context.
- write in first person; convert any third-person references to the assistant into first person, and refer to the user by name where known.
- Progress: move completed "In Progress" items to "Done".
- update "Next Steps" for completed work.
- preserve exact file paths, function names, error messages.
- MAY remove irrelevant content.
- If new messages end with an unanswered user question/request: add it to Critical Context; replace any previous pending question if answered.
- output only the structured summary; NEVER extra text.
- keep sections concise.
- preserve relevant tool outputs/command results.
- include mentioned repository state changes (branch, uncommitted changes).

Format (omit inapplicable sections):

## Goal
[Preserve existing goals; add new ones if task expanded]

## Constraints & Preferences
- [Preserve existing; add new ones discovered]

## Progress

### Done
- [x] [Include previously done and newly completed items]

### In Progress
- [ ] [Current work—update based on progress]

### Blocked
- [Current blockers—remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context; add new if needed]

## Additional Notes
[Other important info not fitting above]
