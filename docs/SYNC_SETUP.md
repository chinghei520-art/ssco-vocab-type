# Practice-history sync

Google sign-in can merge **attempt history only** across browsers for the same account. Vocabulary (`ssco-vocab-items-v1`) and the unfinished round (`ssco-vocab-session-v1`) stay on the device.

`firebase-config.js` now holds the public web config for Firebase project `ssco-vocab` (Spark, no service account). If that object is removed or set back to `null`, the app does not load Firebase and keeps the on-device log. Do not replace it with a key from a different project, and do not commit a service account.

An unauthenticated Firestore read of this project is denied. Signing in with Google and checking two browsers against the live project is still a manual step; automated tests do not perform that sign-in.

## Why Firebase

The site is static GitHub Pages. Firebase Auth (Google) plus Cloud Firestore is enough: the browser signs in, and security rules — not a secret in the repo — decide who can read which rows. The Spark plan covers Auth and Firestore without turning on billing. No admin SDK, Cloud Function, or service account is required for this design.

## What is stored

```
users/{uid}/attempts/{attemptId}
users/{uid}/sync/state
```

An attempt is `{ id, t, day, unit, zh, answer, typed, ok, v }`. `id` is a client id. Rows already on the device without an id get a stable `leg_` id from their fields, so uploading the same browser log twice does not double-count. New attempts use an `a_` id stored before upload, so a retry writes the same document.

`sync/state` is `{ clearRev, clearedThrough, updatedAt }`. It only moves forward. Rules reject deleting it and reject a smaller `clearRev` or `clearedThrough`. A create/update of an attempt with `t <= clearedThrough` is rejected, so a cleared row cannot be put back.

## Device behavior

| Situation | What the screen uses | Cloud |
| --- | --- | --- |
| Config null, or still the placeholders | This browser's anon log, newest 200 on each new signed-out save | Not contacted |
| Config contains a private key or service-account field | Rejected. Local-only, with an error | Not contacted |
| Signed out | Anon log only. Account caches stay on disk under that uid and are not shown | Not deleted |
| First Google account on this browser | Claims the anon log once, then the merged account history (not capped at 200) | Upload by id |
| Later signed-out practice | Stays in the anon log. It is not auto-uploaded to any account | Untouched |
| A different Google account | Sees only that account. It does not receive the first account's rows or the leftover anon log | Separate `users/{uid}` |
| Signed-out clear | Deletes the anon log on this browser only | Untouched |
| Signed-in clear | Writes the tombstone, then deletes older attempt docs. Other devices drop those rows on the next sync and do not upload them again | Tombstone + deletes |
| Sign out | Hides the account. Does not write a tombstone | Kept |

Sign-in asks for confirmation before the first claim, because that log is bound to the first account that signs in on that browser. Sign-out asks for confirmation and states that cloud data is kept. Signed-in clear asks for confirmation and states that every device for that account loses the cleared history. Word lists and the current round are not part of clear.

Offline attempts sit in `ssco-vocab-account-outbox-v1:{uid}` and upload when the network returns. The same id is used, so a retry does not add a second row. Firestore's own IndexedDB cache is left off so signing out does not leave the previous account's query cache behind; the per-uid localStorage cache is the offline copy, and it is shown only while that uid is signed in.

Clocks should be roughly correct. `clearedThrough` is compared with each attempt's `t`. A device whose clock is far ahead can tombstone rows that other devices still consider recent.

## Security rules

`firestore.rules` is the authorization policy:

- only `request.auth.uid == uid` can read or write `users/{uid}/...`
- attempt updates must repeat the same fields (retries are allowed, edits are not)
- `sync/state` cannot be deleted or moved backward
- attempts at or before `clearedThrough` cannot be created again
- every other path is denied

Deploy that file. Do not switch the database to test mode.

## Provision a free project

1. Create a Firebase project on the Spark plan. Do not enable billing.
2. Authentication → Sign-in method → enable **Google**.
3. Authentication → Settings → Authorized domains, add:
   - `chinghei520-art.github.io`
   - `localhost`
   The `firebaseapp.com` domain is added automatically.
4. Google Cloud console → APIs & Services → OAuth consent screen. User type External. While the app is in testing, add the Google account you will sign in with as a test user. Publishing the consent screen is what lets any Google account sign in; that is a Google Cloud setting, not a code change.
5. Build → Firestore Database → Create database → **production mode** → Native mode → a region near you (for example `asia-east2` if offered, otherwise `asia-east1`). Use the `(default)` database.
6. Project settings → Your apps → Web app. Copy only the web config. You need these public fields:

   | Field | Required |
   | --- | --- |
   | `apiKey` | yes |
   | `authDomain` | yes (`YOUR_PROJECT_ID.firebaseapp.com`) |
   | `projectId` | yes |
   | `appId` | yes |
   | `storageBucket` | no |
   | `messagingSenderId` | no |
   | `measurementId` | no, leave it out |

7. Put them in `firebase-config.js` (this file is loaded by the page):

```javascript
window.SSCO_FIREBASE_CONFIG = {
  apiKey: "paste-web-api-key",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  appId: "paste-app-id"
};
```

The web `apiKey` is not a secret; anyone can see it in the page. Access control is the rules file. Never commit a service account, admin SDK JSON, OAuth client secret, or a field named `private_key`.

8. From this repository, after `npx firebase-tools login` (or `firebase login`):

```bash
npx firebase-tools deploy --only firestore:rules --project YOUR_PROJECT_ID
```

Do not deploy hosting from Firebase. GitHub Pages already serves the site. Pushing `main` publishes the site; this branch does not.

9. Smoke test, in this order, before trusting the numbers:
   - Signed out, the banner stays on local-only until the config is real.
   - Sign in on browser A. The existing anon log moves once. Copy a report and note the merged count.
   - Sign in as the same Google account on browser B. The same attempts and the same unit totals appear, including rows older than the old 200-row cap.
   - Airplane-mode a new attempt on A, then reconnect. B shows it once, not twice.
   - Sign out on a shared browser. The account rows disappear from the screen. A second account does not list them.
   - Clear while signed in only after reading the confirm text. Reload B and confirm those rows stay gone.
   - Confirm an iPhone Home Screen session separately. Phones use a redirect sign-in, and a popup can be blocked.

## Local rules check

```bash
npm test
npm run test:rules
```

`test:rules` starts the Firestore emulator with `demo-ssco-vocab` (no cloud project and no credentials) and asserts cross-user reads and writes fail. That is not a substitute for the two-browser check above.
