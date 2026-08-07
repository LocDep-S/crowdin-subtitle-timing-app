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

**Overflow past one field's size cap:** Crowdin caps a single custom field's
value at 65,535 characters. The blob above holds *every* customized
language for a file combined into one value, so a file with several
customized languages (or just one language with a lot of cues) can cross
that cap - every future clone/split/merge/delete write for the file would
then fail outright with a `fieldValidationFailed` error, for every language,
not just the one being edited. To keep working past that ceiling, once the
combined JSON is too big for one field it's split across additional
numbered fields ("Subtitle Language Cues 2", "-3", ...), created lazily only
the first time a file actually needs them. Reading these back costs nothing
extra: Crowdin already returns every custom field value on a file in the
same API call this app already makes, so reassembly is just concatenating
whichever chunk fields are present, in order, before parsing. If a file's
data later shrinks back under one field's worth (e.g. cues get deleted),
the now-unneeded higher-numbered fields are cleared rather than left
holding stale data.

### Mark as Finished

A "Mark as Finished" button (below the main toolbar) lets a linguist signal
"I'm done with this file+language" - it marks that (file, language) finished
in Crowdin (in the same per-language blob `lib/languageCues.js` already
uses for customized cues - see "Overflow past one field's size cap" above)
and best-effort DMs Daniel on Slack with the exported `.srt` attached
directly to the message (not just a link).

The button flips to a "✓ Finished by [name], [date]" badge plus an
**Unfinish** button - Unfinish just clears the flag quietly (no
notification), so a linguist can make further changes and click Finish
again later, which re-sends the Slack DM with the updated file. Marking a
file finished in Crowdin always succeeds even if the Slack DM fails or
isn't configured - see below.

There's no reliable linguist identity available from Crowdin's Editor
context to auto-fill "finished by", so the panel has a plain "Your name"
field, remembered per-browser (localStorage) after the first time it's
typed.

**Slack setup:** this uses a dedicated Slack bot ("Subtitle Finish
Notifier", in the Sinch workspace), not Crowdin's own Slack integration or
Zapier - plain Slack Incoming Webhooks can't attach real files (link-only),
and Zapier wasn't reliable enough at the time to depend on for this. The
bot needs two Render env vars to actually send anything:
- `SLACK_BOT_TOKEN` - Bot User OAuth Token (`xoxb-...`) for the app, scopes
  `chat:write`, `files:write`, `im:write`, `users:read`.
- `SLACK_NOTIFY_USER_ID` - Slack member ID to DM (Daniel's is
  `U02NPLAHSE6`).

Both are optional by design (`lib/slackNotify.js`): if either is missing,
marking a file finished still works, just without the Slack DM - useful
since the bot's install into the Sinch workspace needs a workspace admin's
approval (requested via "Request to Workspace Install" - Daniel isn't an
admin there) before `SLACK_BOT_TOKEN` even exists.

### Reupload .srt

For linguists who'd rather edit in a dedicated subtitle tool than this
panel: **Export .srt** to get the current file, edit it anywhere, then
**Reupload .srt** to bring it back into Crowdin wholesale. Text, timing,
order, and cue count all come straight from the uploaded file - cues can be
freely added, removed, reordered, or merged externally and this just
replaces everything for that language with whatever the file says.

There's no way to map an arbitrarily-edited file's lines back to the
specific Crowdin source strings they may have started from, so - exactly
like clone/split/delete - this fully "customizes" the (file, language):
every read/write for it goes through this app's own per-language storage
from here on, not Crowdin's source strings/translations (see "Customized
cue lists" above for the full trade-off). Because this replaces the entire
cue list in one shot rather than editing one cue, the panel asks for
confirmation before doing it.

### Overlap warning

Any two cues in the same language whose time ranges overlap (regardless of
their order in the list - this is recomputed after every edit) get an orange
highlight and an "overlaps another cue" tag, so a linguist can spot and fix
timing collisions after adjusting or splitting cues.

### Reimport text

Editing a cue's text on the right pins it - Crowdin can go on to get newer
translation edits on the left, and this app won't notice until told to.
**Reimport text** is the escape hatch: it pulls fresh text from Crowdin's
current source/translation for every cue in the active language, and
deliberately leaves two things alone:
- **Timing** - any per-cue start/end correction stays exactly as set.
- **Cue count/order (clones, splits, deletes)** - reimporting never adds
  back a deleted cue or collapses a split.

The one thing it *can't* safely do: a cue that was cloned/split shares its
one Crowdin string with its sibling half(s) - there's only one live
translation to pull from, and no way to know which half should receive it.
Rather than guess (and silently overwrite a manually-divided split),
Reimport leaves split cues' text untouched and only refreshes cues that
still map 1:1 to a single Crowdin string.

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

**Fullscreen uses a custom button, not YouTube's own.** YouTube's built-in
fullscreen control fullscreens the `<iframe>` itself - and `#subtitle-overlay`
is a sibling element outside that iframe (a cross-origin document this app
can't inject into), so the native control would silently leave the overlay
behind the moment someone went fullscreen. `playerVars.fs = 0` removes
YouTube's fullscreen button entirely, and the small ⛶ button in the corner of
the player fullscreens `#player-wrap` instead (the div containing both the
iframe and the overlay), so video and subtitles go fullscreen together.

**The overlay is a solid, full-width bar, not a small translucent label.**
`cc_load_policy: 0` only sets YouTube's *default* caption state - it can't
override a linguist's own YouTube/Google account setting to always show
captions, or a manual click on YouTube's CC button, which is still present
in its control bar (unlike fullscreen, there's no documented `playerVar` to
remove that button). So rather than relying on English captions never
appearing, `#subtitle-overlay` is a fully opaque, full-width band pinned to
the same bottom zone YouTube renders captions in - if YouTube's own caption
does get triggered underneath, this reliably paints over the whole area
instead of sitting next to or partially over it the way the earlier
shrink-to-fit, semi-transparent pill design could.

**`<i>`, `<b>`, and `<u>` render as real formatting in the overlay** -
common SRT emphasis tags for on-screen text, whispers, or song lyrics -
so what a linguist sees while previewing matches what actually ships.
`public/panel.js`'s `safeSubtitleHtml` is a small allowlist, not a general
HTML sanitizer: it escapes the cue's text first, then re-expands only the
exact escaped form of those three bare tags. A tag with attributes (e.g.
`<i onclick=...>`) or any other tag name never matches, so it stays
escaped and shows as literal text - cue text comes from
translators/Crowdin, not from us, so treating arbitrary markup as live
HTML would let subtitle content inject into this page. The cue-editing
textarea still shows tags as literal text while typing (textareas can't
render markup), so this only affects the video preview, not the edit box.

### Timecode readout

A small `mm:ss.mss` readout sits in the top-left corner of the video,
always showing the exact current playback position - **including while
paused**. It uses the same format as the start/end timing inputs below the
video, so a linguist can pause on the exact frame a line starts or ends
and type that value straight into the corresponding field instead of
estimating it by eye or nudging in 100ms increments to find it.

### Character counts

A small column to the right of each cue's text shows character counts, so a
linguist can spot an overlong line at a glance instead of eyeballing it:
per-line counts (only shown once a cue actually has more than one line) plus
a total-characters-for-this-cue count underneath, updating live on every
keystroke - not just after saving. Counts are raw character length,
including any `<i>`/`<b>`/`<u>` markup typed into the line - this matches
what's actually in the field and the exported `.srt`, not the length once
tags are stripped for on-screen display, since deciding which formatting
"doesn't count" is a bigger judgement call this feature isn't trying to make.
No line-length limit is enforced or color-flagged; it's a glance-and-decide
number, since acceptable line length varies by target language and screen.

### "All files" view isn't supported

Crowdin's Editor lets a linguist browse strings across every file in a
project at once (the file switcher's "All files" option). Video & Timing
needs one specific file to know which video/cues to show, so opening the tab
in that mode now shows a clear message asking you to pick a single file
instead - it previously tried to call Crowdin's API with a file id of `"all"`
(the literal value Crowdin's context passes in that mode) and surfaced as a
bare, unhelpful "Request failed with status code 404".

### Reimport text

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

**Keeping it awake:** Render's free tier spins the app down after ~15
minutes with no inbound traffic, so the first request after that pays a
cold-start delay (usually 30-60s, occasionally longer). `.github/workflows/keep-alive.yml`
pings `/manifest.json` every 10 minutes via a GitHub Actions scheduled
workflow - runs on GitHub's own infrastructure, so it works nights/weekends
regardless of whether anyone's laptop is on. This isn't an officially
supported Render feature, just a scheduled HTTP request like any browser
tab hitting the URL; if usage ever outgrows it, the supported fix is
upgrading the Render service to a paid instance instead.

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
