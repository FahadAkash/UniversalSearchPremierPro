# Universal Search — Premiere Pro CEP Extension

A real CEP (Common Extensibility Platform) panel for Premiere Pro: a search
box that queries your open project's clips/effects/sequences and drives
real selection + playhead moves inside Premiere via ExtendScript.

## What's real vs. what's simulated

**Real, via Premiere's ExtendScript API (`jsx/hostscript.jsx`):**
- Reading every sequence/track/clip and its applied effect names
- Selecting one or more clips in the actual Premiere timeline
- Switching the active sequence
- Moving the playhead to a clip's in-point
- Once a clip is selected via script, Premiere's own Program Monitor,
  Effect Controls, and Properties panels update on their own — that's
  native Premiere behavior, not something this plugin has to fake.

**Our own UI, not literally inside Premiere's native timeline:**
- The mini timeline strip at the bottom is drawn by this panel from the
  same data as the search results. Its purple hover-glow and match
  highlighting live here, not painted onto Premiere's real timeline
  pixels (Adobe doesn't expose a way to do that).
- "Live sync" is polling every 700ms, not a push/event subscription —
  Premiere's scripting API doesn't emit change events.

**Query language — supported now:** `effect:`, `duration>`, `sequence:`,
`nested:`, plain text search.
**Parsed but not yet backed by real data:** `intensity`, `audio.*`,
`label:`, `camera:`, `fps:`, `has:`, `missing:`, `font:`, `color:`,
`transition:`, `rendercost:`, `motion.*`, `marker:`, `created:`. The
panel tells you in the result count when a query used one of these,
rather than silently returning fake matches. Wiring these up is possible
(e.g. `has:warp-stabilizer` by checking component names, `created:` via
`projectItem.getMediaPath`'s file mtime) but needs per-effect-type
handling — happy to build any of these out next.

## Install — Windows, automatic

1. Close Premiere Pro if it's open.
2. Right-click **`install.bat`** → **Run as administrator**.
   It enables CEP's `PlayerDebugMode` (needed since this isn't
   Adobe-signed) and copies the extension into
   `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\UniversalSearch`.
3. Reopen Premiere Pro → **Window → Extensions → Universal Search**.

To remove it later, right-click **`uninstall.bat`** → **Run as administrator**.

`install.bat` only automates the Windows steps below — it edits the
registry and copies files, nothing more. Read it before running if
you'd like to check that first (plain text, no obfuscation).

## Install — manual / Mac

1. Enable unsigned extensions — Premiere/CEP won't load a non-signed
   panel unless debug mode is on:
   - **Windows**: Registry → `HKEY_CURRENT_USER\Software\Adobe\CSXS.11`
     → add String value `PlayerDebugMode` = `1` (match the CSXS number
     to your Premiere version if different).
   - **Mac**: `defaults write com.adobe.CSXS.11 PlayerDebugMode 1`
2. Copy this whole `UniversalSearch` folder into your CEP extensions
   directory:
   - **Windows**: `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\`
   - **Mac**: `/Library/Application Support/Adobe/CEP/extensions/`
3. Restart Premiere Pro.
4. Open it from **Window → Extensions → Universal Search**.

## Files

- `install.bat` / `uninstall.bat` — Windows one-click install/remove
- `CSXS/manifest.xml` — extension registration
- `jsx/hostscript.jsx` — ExtendScript bridge (the "real" part)
- `js/CSInterface.js` — Adobe's official CEP↔panel bridge library
- `js/query-engine.js` — query language parser + filter logic
- `js/timeline.js` — mini timeline renderer
- `js/main.js` — polling loop, search UI, batch actions
- `index.html` / `css/style.css` — panel UI

## Premiere Pro API Capabilities & Limitations (The "Black Box")

Universal Search uses Adobe's ExtendScript API to scan your timeline. While it is incredibly powerful, Adobe places strict limitations on what parameters are actually exposed to scripts. 

### ✅ Fully Supported (Scannable)
These effects and properties expose their internal parameters to the ExtendScript API. You can search them using their exact names or properties (e.g., effect:"Lumetri Color", opacity<50, olume:5).

| Category | Examples / Properties |
| --- | --- |
| **Standard Video Effects** | Lumetri Color, Gaussian Blur, Transform, Crop, Ultra Key, Tint, Drop Shadow |
| **Motion Properties** | Position, Scale, Rotation, Anchor Point, Anti-flicker Filter |
| **Opacity Properties** | Opacity, Blend Mode |
| **Standard Audio Effects** | Volume (Mute, Level), Channel Volume |
| **Third-Party Video Plugins** | Boris FX (Sapphire/Continuum), Red Giant Universe, Video Copilot (usually hook into the standard API) |
| **Clip Metadata** | Name, MediaType, Duration, Track, Sequence, Framerate, Codec, Label, Offline Status, Timecode |

### ❌ Unsupported (The API "Black Box")
These components are treated as encapsulated "Black Boxes" by Premiere Pro. They use custom internal architectures and literally expose **zero parameters** to the ExtendScript API. Because the parameters are invisible to scripts, Universal Search cannot see or query them.

| Category | Examples / Properties | Reason for Limitation |
| --- | --- | --- |
| **Advanced Audio / VSTs** | Parametric Equalizer, Graphic Equalizer, Dynamics, Reverb, Chorus, Mastering | Encapsulated in the "Custom Setup" UI; no properties are mapped to the script API. |
| **Intrinsic Audio Routing** | Panner (Balance) | Treated as an intrinsic track/clip routing feature, omitted from the clip.components list in ExtendScript. |
| **Third-Party Audio VSTs** | iZotope, Waves, FabFilter, etc. | Identical to advanced native audio effects; completely hidden from scripting. |
| **Internal Text/Caption Engines** | Essential Graphics Text Content, SRT Captions | While the layer exists, reading the actual string of text typed inside the caption block is often blocked or heavily restricted by the API depending on the Premiere version. |
