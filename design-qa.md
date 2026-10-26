# Design and release QA

**Last verified:** 2026-10-26
**Git base:** `main` / `origin/main` at `9aaa3df23dde64f75394200ce4321bbb8fe1a7b7`. The local working tree contains uncommitted control/audio changes based on this same commit.
**Release state:** not published from this worktree.

## Verification performed

- Earlier visual review recorded a desktop control page and a 390×844 phone layout; additional viewport checks at 320, 360, 480, and 768 pixels reported no document-level horizontal overflow. That earlier pass covered employee selection, call-type choices, meeting details, and the busy-confirmation dialog. This review did not repeat those visual captures.
- `npm test`: 100 passed, 0 failed.
- `npm run build`: passed.
- `git diff --check`: passed after removing trailing whitespace from this report.
- Realtime call-audio path uses Groq server-side, a private WAV cache descriptor, a display-side IndexedDB cache, a cross-instance Firebase lock, and a persisted cooldown when the provider rate-limits. WAV bytes are not stored in Firebase.
- Existing administrator authentication and role-permission tests still pass; the three administrator roles remain distinct, and employee accounts are not part of the model.
- Fixed office WAV assets have not been generated; they remain pending review of the first real audio sample.

## Repository and deployment comparison

- GitHub's default branch is `main`; after fetching `origin`, its tip and the local `HEAD` were identical at `9aaa3df23dde64f75394200ce4321bbb8fe1a7b7`.
- The newest Vercel production deployment is `READY` and points to the same commit and repository branch.
- The local source changes are an uncommitted overlay on that shared base; there is no commit divergence or merge conflict. QA screenshots and reports under `output/` are local artifacts and are not included in the source change set.
- The deployed `/api/control/config` check reported its Firebase/auth runtime configuration as unavailable. Vercel project settings contain production configuration entries added after the currently deployed build, so a later deployment is required before those values can be tested at runtime.
- The production display UID allowlist is empty, and `GROQ_API_KEY` is not present in Vercel production environment settings. Therefore production audio generation is not ready.
- The real browser audio/cache test has not passed: the local browser test was stopped before opening its page, so no Groq request or real sample was generated in that run.

## Remaining release gates

1. Review the exact local diff and commit the intended source changes on top of the verified GitHub `main` commit; do not include `output/` QA artifacts or ignored secrets.
2. Configure the required server-only Groq secret and the trusted display UID without exposing either in Git or the client bundle.
3. Verify administrator password records and Firebase runtime configuration using the newly deployed code, then verify the screen's visual and audio acknowledgement flow without sending a live company call.
4. Review one real Saudi-voice sample before generating the 15 fixed office assets. The current model is marked Preview by Groq, so production suitability remains a release decision.

No GitHub push or Vercel deployment was performed by this QA pass.
