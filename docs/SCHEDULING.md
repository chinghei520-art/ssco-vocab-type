# Scheduling trial (v2.1)

Not deployed with this pull request. Cloud review sync needs the rules diff below; do not publish those rules until this trial is accepted.

## Library

- Package: `ts-fsrs@6.0.0`, vendored at `vendor/ts-fsrs-6.0.0.umd.js` (MIT).
- Model: **FSRS-6**, selected with `version: "FSRS-6"`. ts-fsrs 6 defaults to FSRS-7. This trial stays on FSRS-6, the library's previous supported preset, and does not implement the wiki's FSRS-7 text.
- Weights: library preset. No personal optimizer.
- `desiredRetention: 0.9`. This is the model's target, not a promise the learner will remember 90%.
- `enableFuzz: false` so the same events always produce the same due time.
- Short steps are the library defaults (`1m`, `10m`), not a 1/3/7 day ladder.

If the library fails to load, practice still runs and no due dates are invented.

## What is a card

Id `c_` plus a stable hash of unit, Chinese prompt, blank index, and the answer list. Units stay in that id and are not shown. The 55-item bank is unchanged. Old attempt logs are kept and are **not** replayed as FSRS grades.

## Grades

Only the first observation in a session can schedule. Later repeats in that session are remediation.

| What happened | FSRS grade | Due date |
| --- | --- | --- |
| New or due card, first try correct, no hint, answer not shown | Good | Model chooses the next due time |
| New or due card, wrong, skip, hint, or answer shown before a correct try | Again | Sooner, history kept |
| Same session after that | none | Unchanged |
| Extra practice while not due, unhinted correct | none | Not pushed later |
| Extra practice while not due, wrong or skip | Again | Sooner |

There is no Hard/Easy and no speed grade. Hinted success is not Good. A correct try after the answer was shown is not Good.

Replay sorts by time, then id, and recomputes the grade. A client's stored grade is not trusted. Two devices therefore merge by keeping both events.

## Trial metric

**延遲獨立拼寫率** = cards whose latest independent first try was correct on a Hong Kong date after the day they were introduced, divided by every active card, including new cards.

Same-day learning, hints, skips, and remediation are not successes. Overdue does not mean wrong and does not clear the last result. Show the counts. If the bank size changes, the denominator changes with it. This is not the 0.90 target and not a mastery score.

Hong Kong dates use `Asia/Hong_Kong`.

## Cloud rules (not deployed)

Add this block beside the existing attempt rules. Do not change the attempt rules, so v2.0 clients keep working. Rollback: remove this block; local events remain; attempts are untouched.

```
match /users/{uid}/reviews/{eventId} {
  allow read: if isOwner(uid);
  allow create: if isOwner(uid)
    && eventId == request.resource.data.id
    && validReview(request.resource.data)
    && notCleared(uid);
  allow update: if false;
  allow delete: if isOwner(uid);
}
```

`validReview` is in `firestore.rules`. Until this is published, review upload is denied, the banner says the schedule stayed on this device, and practice continues. v2.0 clients do not write reviews. A v2.0 clear still advances the same tombstone; a v2.1 client then drops review events at or before that time.
