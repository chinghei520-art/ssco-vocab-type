# Scheduling trial (v2.1)

v2.2 changes the display only. Grades, due dates, the review event, and Firestore rules are the same as v2.1.

## Display (v2.2)

The card list and the answering screen are separate pages. Starting practice leaves the **進度表**; the list is not stacked above or below the blank. The homepage trial metric **延遲獨立拼寫率** is a large count, with **今日獨立首次** and **今日補救（唔算獨立）** beside it. The card list is a **進度表**: one row per card, status only 新卡 / 到期 / 未到期, next due date, and the last independent first try (獨立正確 / 用過提示 / 睇過答案 / 跳過 / 錯 / 未有). Source unit stays collapsed until **顯示來源單元**. A separate toolbar **進度表** sorts those columns and does not replace the practice **紀錄** sheet. **複製報告** adds the same three trial lines. None of these is a mastery score, and the table heading does not show the FSRS 90% model target. Skip and Check appear only on the answering page. The table does not claim that review rules are unpublished. A signed-out session keeps the existing 「未設定雲端」 banner. If review upload is denied, the existing sync banner still adds 「排程仍在本機，雲端規則未更新」.

Review rules for `users/{uid}/reviews` were published on 2026-11-16 (ruleset `7b30c3a1-a2f1-415e-b91f-7f4853f01e2a`). This pull request does not change `firestore.rules`.

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

## Cloud rules

Published 2026-11-16 beside the existing attempt rules. The attempt rules stay as they were, so v2.0 clients keep working. Rollback: remove this block; local events remain; attempts are untouched.

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

`validReview` is in `firestore.rules`. If a later rules publish rejects review upload, the sync banner says the schedule stayed on this device and practice continues. v2.0 clients do not write reviews. A v2.0 clear still advances the same tombstone; a later client then drops review events at or before that time.
