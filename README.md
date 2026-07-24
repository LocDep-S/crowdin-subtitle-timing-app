# Subtitle Video & Timing Editor — a Crowdin App

A Crowdin App that adds a "Video & Timing" tab to the Editor's right panel.
It shows the source video synced to the cue you're translating, and lets you
correct that cue's **timing independently for each target language** -
without ever touching the English source file, its structure, or any other
language's timing.

## Why this design (read this before the code)

Earlier drafts of this app tried to fix cue timing/order by re-uploading a
whole new source `.srt`. That's wrong for what you actually need: different
languages legitimately need different timing (a French sentence may run
longer than the English original), and the English source must never move.

So this version was redesigned around facts **verified live against a real
Crowdin Enterprise project** (not just docs), specifically the "Sinch
Subtitling AIT+AIPE+HPE" project:

- Every subtitle cue's timing already lives in that string's own `context`
  field, in the exact format Crowdin's SRT importer writes it:
  `"Start time: 00:00:09,503\r\n End time: 00:00:12,971"`. That's a single
  value per string, shared by every language.
- The file's `context` field was already being used, in that same project,
  to hold a plain video URL (a Vimeo review link) - so this app reuses that
  same field/convention instead of inventing its own video-URL storage.
- Translations are pure text. There is **no per-language timing field
  anywhere in Crowdin's data model** - confirmed by pulling real French
  translations off that project (text only) and by testing whether custom
  Fields support a per-translation/per-language scope (they don't; Fields
  are scoped to project/file/string/user/task only).

Consequence: Crowdin's own "Download translations" / build feature will
**always** reconstruct a language's `.srt` using that one shared source
`context` timing, no matter what this app does - there's no per-language
slot for it to read from. This app is the thing that actually produces a
correctly-timed **per-language** `.srt`; Crowdin remains the system of
record for translation text, review, and workflow.

## Architecture

```
manifest.json           <- App Descriptor Crowdin fetches to learn about the app
render.yaml              <- Render Blueprint (documents the hosted service config)
server.js                 <- Express app: manifest, install hooks, panel, API
lib/crowdinAuth.js         <- OAuth token exchange + jwtToken verification
lib/crowdinApi.js           <- Crowdin REST calls (read strings/translations, patch file/string metadata)
lib/timingField.js           <- Per-language timing overrides, stored as a Crowdin custom Field
lib/srt.js                    <- Timecode <-> ms conversion, context-field timing parser, .srt export writer
lib/store.js                    <- OAuth installation credentials, stored in Upstash Redis
public/panel.html+js+css         <- The editor-right-panel UI (video player + per-language cue timeline)
public/dev-harness.html            <- Standalone demo (no Crowdin needed) - includes a language switcher
test/sample.srt                     <- Sample subtitle file for the dev harness
test/mock-upstash-smoke-test.js      <- Verifies lib/store.js against a fake Upstash server (no real account needed)
```

### What's editable, and where it's stored

| Thing | Editable here? | Where it lives |
|---|---|---|
| Cue text | **Yes, per language** | A custom Crowdin Field on the string (`subtitle-timing-overrides`), keyed by language id - or, once a file+language is "customized" (see below), inside that language's app-owned cue list |
| Cue start/end timing | **Yes, per language** | Same as above |
| Cue count / order (clone, split, merge, delete) | **Yes, per language** | Only possible via the app-owned cue list (see "Customized cue lists" below) - Crowdin's source file structure is never touched |
| Video link | Yes (one per file) | The Crowdin file's own `context` field |

None of this ever touches Crowdin's English source file, its structure, or
any other language's data - see "Customized cue lists" below for the one
caveat worth knowing about.

### The timing/text field

`lib/timingField.js` creates one custom Field (org-wide, scoped to `string`,
named "Subtitle Timing Overrides") the first time the app is installed, and
stores a small JSON blob per string: `{"fr": {"startMs":.., "endMs":.., "text":".."}, "es": {...}}`.
Editing French timing or text only ever touches the `"fr"` key - every other
language's entry, and the string's own source `context`, is left alone. This
covers simple corrections where the cue count/order for that language hasn't
changed.

### Customized cue lists (clone / split / merge / delete)

Crowdin has no concept of "extra cues that only exist for one language" -
cue count and order are fixed by the source file and shared by every
language. So cloning a cue (to then split it in two) or deleting one (e.g.
after merging its text into a neighbor) can't be represented as a per-string
override the way timing/text can.

Instead, `lib/languageCues.js` creates a second custom Field (org-wide,
scoped to `file`, named "Subtitle Language Cues"). The **first time** a
linguist clones or deletes a cue for a given file+language, the app
snapshots that language's entire current cue list (text, timing, order, and
count) into this field and marks it "customized":
```json
{
  "fr": { "customized": true, "cues": [ { "id": "98765", "sourceStringId": 98765, "startMs": 9600, "endMs": 13100, "text": "..." }, ... ] },
  "es": { "customized": false }
}
```
From that point on, this file+language is fully owned by the app - every
read and edit (text, timing, clone, delete) goes through this cue list
instead of Crowdin's source strings. **Export .srt always reflects it
correctly.**

**The trade-off (confirmed acceptable before building this):** once a
file+language is customized, Crowdin's own translation grid, QA checks, and
reports for that file+language may no longer reflect what's actually
shipped. For example, a deleted cue's original source string still exists
in Crowdin and can show up as "untranslated" in the main Editor, since
deleting a cue here deliberately does **not** touch that string's actual
Crowdin translation (or the string itself) - it only removes it from this
language's view in the app. If a file+language hasn't been customized (no
clone/delete used yet), nothing changes: cues are still derived live from
Crowdin exactly as before, and Crowdin's own views stay accurate.

### Overlap warning

Any two cues in the same language whose time ranges overlap (regardless of
their order in the list - this is recomputed after every edit) get an orange
highlight and an "overlaps another cue" tag, so a linguist can spot and fix
timing collisions after adjusting or splitting cues.

### Subtitle overlay on the video

The video player burns in the **current target language's** cue text as it
plays - never the English source - so a linguist can watch the video and see
exactly what will ship for the language they're in, including any unsaved
edit sitting in the text box. This works by reusing the same active-cue
lookup that drives the highlighted row (`public/panel.js`'s `startTimeSync`),
and YouTube's own caption track is explicitly turned off
(`cc_load_policy: 0`) so it can't show through underneath. Switching
languages (or the active cue itself changing) updates the overlay within one
poll tick (250ms).

:::warning Not yet smoke-tested against a live project
Reading cue timing (`context`) and translations was verified against a real
Sinch Crowdin project during design - deliberately **read-only**, to avoid
changing anything in your live org without sign-off. **Writing** the custom
field's value (`lib/timingField.js`'s `writeOverride`) was not tested the
same way, so the exact JSON-Patch path (`/fields/{slug}`) is a best-effort
implementation, not a confirmed one. Before relying on this for real:
1. Install the app on one disposable/test project (e.g. one of the "Test …"
   projects already in your org) or a throwaway one.
2. Open a subtitle file, edit a cue's timing, and check in Crowdin's own UI
   (the string's side panel -> Fields) that the JSON blob actually shows up
   and updates correctly.
3. If the patch path doesn't match your org's Crowdin version, adjust
   `writeOverride` in `lib/timingField.js` - it's isolated to that one
   function.
:::

## Try the UX right now, without installing anything in Crowdin

```bash
npm install
npm run dev
```

Open **http://localhost:3000/dev** - loads `test/sample.srt` and a sample
YouTube video, with a language dropdown (en/fr/es/de) so you can see the
core idea directly: switching languages shows independent timing, and
editing one language's timing never affects another's. (The dev harness has
no Crowdin connection, so it shows the same source text under every
language rather than a real translation - that part only happens once
connected to Crowdin.)

## Installing it into Crowdin for real

**The app is already deployed** (see Deployment section below) - to install
it, skip straight to step 5 and use
`https://crowdin-subtitle-timing-app.onrender.com/manifest.json` as the
manifest URL. Steps 1-4 below are only needed if you want to run your own
copy locally (e.g. to test a code change) instead.

1. `npm install`
2. Get a public HTTPS URL for local testing: `ngrok http 3000` (or any tunnel tool).
3. Copy `.env.example` to `.env` and set `PUBLIC_BASE_URL=https://xxxx.ngrok.io`
4. `npm start`
5. In Crowdin: **Organization Settings → Apps → Install Private App**, paste
   your manifest URL: `https://xxxx.ngrok.io/manifest.json`
   (Since `manifest.json` declares `"authentication": {"type": "crowdin_app"}`,
   Crowdin generates the `clientId`/`appSecret` itself and POSTs them to
   `/hooks/installed` - no separate developer-portal OAuth registration
   needed.)
6. Open a project with a subtitle file, open the Editor for a target
   language, and you should see a **"Video & Timing"** tab in the right
   sidebar, already showing that language's timing.
7. First time on a file: click **Video…**, paste the video link, save (this
   writes it into the file's own `context` field in Crowdin).
8. Adjust timing as needed - each edit saves immediately, scoped to the
   language you're currently in.
9. Click **Export .srt** to download the fully assembled, correctly-timed
   subtitle file for that language (text from Crowdin + this language's
   timing overrides). This, not Crowdin's own download button, is the file
   to actually ship.
10. Click **Download video** if a linguist wants the video + .srt side by
    side locally (e.g. to fine-tune timing in VLC). This only proxies real
    bytes when the saved link points straight at a video file (e.g. ends in
    `.mp4`). For platform pages - including YouTube - there's no API for the
    raw file; we tried extracting YouTube's stream server-side via
    `@distube/ytdl-core`, but YouTube blocks requests from cloud-hosting IPs
    like Render's with a 429 almost immediately, regardless of who owns the
    video, and it wasn't worth the ongoing cookie-credential maintenance to
    chase further. So the button opens the source video in a new tab
    instead, and the linguist uses whatever download path they're actually
    authorized to use there. If a linguist needs a real one-click download
    for a specific video, point that file's video link at something built
    for direct downloads instead - a Vimeo link with downloads enabled, or a
    direct file URL (S3, Drive direct link, etc.) - both already work today.

## Deployment: Render (free) + Upstash Redis (free)

**This is already deployed and live:**
- Code: [github.com/LocDep-S/crowdin-subtitle-timing-app](https://github.com/LocDep-S/crowdin-subtitle-timing-app)
- Running at: `https://crowdin-subtitle-timing-app.onrender.com` (Render free
  web service, auto-deploys on every push to `main`)
- Manifest to install into Crowdin: `https://crowdin-subtitle-timing-app.onrender.com/manifest.json`
- Storage: an Upstash Redis database (`crowdin-subtitle-timing-app`, `us-east-1`)

This app is built to run on Render's free web-service tier, using Upstash
Redis for the one piece of state it needs to persist (OAuth installation
credentials) - free hosts generally don't offer persistent local disk, so
`lib/store.js` talks to Upstash over the network instead of writing a local
JSON file.

`test/mock-upstash-smoke-test.js` verifies `lib/store.js` end-to-end against
a fake Upstash server (no real account needed) - run it with
`node test/mock-upstash-smoke-test.js`. It's worth keeping: it already
caught two wire-format mistakes once (the client batches calls into
`POST /pipeline`, and values must round-trip as raw strings, not
pre-parsed objects) that would otherwise have silently broken OAuth
persistence in production.

To actually deploy:
1. Create free accounts on **GitHub**, **Render**, and **Upstash** (no card
   needed for any of them at this tier).
2. Generate one credential from each:
   - GitHub -> Settings -> Developer settings -> Personal access tokens ->
     Tokens (classic) -> generate with the `repo` scope.
   - Render -> Account Settings -> API Keys -> Create API Key.
   - Upstash -> Console -> Account -> Management API -> Create API Key
     (used together with your Upstash account email).
3. With those three credentials, everything else - creating the GitHub repo
   and pushing this code, creating the Upstash Redis database, creating the
   Render web service and wiring `PUBLIC_BASE_URL` /
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` into it - can be
   done via each service's API, with no manual dashboard clicking.
4. Once live, install the Render URL's `/manifest.json` into Crowdin the
   same way described above for the ngrok URL.

## Known limitations

- **Crowdin's own "Download translations" button will never reflect these
  timing corrections** - that's a hard platform limitation (no per-language
  timing slot exists in Crowdin's model), not something this app works
  around. Make sure whoever pulls the "final" subtitle file uses this app's
  **Export** button, not Crowdin's native export, for any file where timing
  has been corrected.
- **Detecting the active target language relies on `AP.getContext()`'s
  `editor.target_language_id` / `active_target_language_id`** fields,
  confirmed against Crowdin's Apps JS SDK docs but polled on an interval
  (1.5s) rather than pushed via an event, since no "language changed" event
  was confirmed available at design time. If Crowdin's SDK documents one for
  your installed version, swap the `setInterval` in `public/panel.js`'s
  `watchLanguage()` for that event instead.
- **The custom Field write path is unverified** - see the warning above.
  Smoke-test on a disposable project before rollout.
- **Once a file+language is "customized" (a cue has been cloned or deleted
  on it), Crowdin's own translation grid/QA checks/reports for that
  file+language may drift out of sync with what's actually shipped** - see
  "Customized cue lists" above. This was a deliberate, confirmed trade-off,
  not a bug: Export .srt is always correct; Crowdin's native views are not,
  for that specific file+language, from that point on.
- **`lib/store.js` keeps all installations in one Redis key** - simple and
  fine at the scale of a handful of org installs, but if this app is ever
  installed by many separate Crowdin organizations, split that into one key
  per domain rather than one shared blob, to avoid concurrent-write
  clobbering between unrelated orgs' installs.
- No automated tests included; `lib/srt.js` and `lib/timingField.js` are
  small enough to unit-test easily if you want CI coverage.
