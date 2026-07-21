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

## 🔍 Search Expressions Reference

Universal Search parses space-separated filter expressions (tokens). Each token has the format `key operator value` (e.g., `scale > 100`).

### Supported Comparison Operators
* **`:`** or **`=`** (Equals) — e.g. `mediatype:video`
* **`!=`** (Does not equal) — e.g. `track != V1`
* **`>`** (Greater than) — e.g. `opacity > 80`
* **`<`** (Less than) — e.g. `duration < 5`
* **`>=`** (Greater than or equal to) — e.g. `scale >= 120`
* **`<=`** (Less than or equal to) — e.g. `scale <= 50`

### Negation (`-` or `!`)
Prefixing a supported key or term with `-` or `!` negates the match (e.g. `-effect:blur` matches clips without a blur effect).

### Text Search
If a word has no operator, it defaults to a plain text search matching the clip's name (e.g. `B-Roll` searches for clips with "B-Roll" in their name).

---

### 1. Complete List of Search Keys

| Key | Description | Example |
| :--- | :--- | :--- |
| `name` / `text` / `contains` | Matches characters in the clip's name (case-insensitive) | `name:"Interview"` |
| `sequence` | Matches the name of the sequence the clip belongs to | `sequence:"Scene 1"` |
| `track` | Matches track identifier (track type + index) | `track:V1`, `track:A2` |
| `mediatype` | Filter by track media type (`video`/`v`, `audio`/`a`, `sequence`/`s`, `transition`/`t`) | `mediatype:video`, `mediatype:a` |
| `duration` | Filter by duration (supports `s`/`sec` or `m`/`min` suffixes; defaults to seconds) | `duration > 15s`, `duration <= 2.5m` |
| `fps` | Filters clips by frame rate | `fps:23.976`, `fps >= 60` |
| `camera` | Filters clips by camera name metadata | `camera:RED` |
| `label` | Matches the clip's Color Label name | `label:Lavender`, `label:Blue` |
| `resolution` | Filters clips by resolution | `resolution:3840x2160` |
| `codec` | Filters clips by codec | `codec:ProRes` |
| `volume` | Audio clip volume in dB | `volume < 0`, `volume:5` |
| `opacity` | Clip opacity percentage (0-100) | `opacity < 100`, `opacity:50` |
| `scale` | Clip scale percentage | `scale > 100`, `scale:120` |
| `rotation` | Clip rotation angle in degrees | `rotation != 0` |

### 2. Built-in Boolean Flags

Use `true` or `false` with these keys:

| Key | Description | Example |
| :--- | :--- | :--- |
| `nested` | Matches nested sequences (nests) | `nested:true` |
| `adjustment` | Matches adjustment layers | `adjustment:true` |
| `graphic` | Matches Essential Graphics | `graphic:true` |
| `caption` | Matches Captions / SRT blocks | `caption:true` |
| `title` | Matches legacy Title clips | `title:true` |
| `textlayer` | Matches generic text layers | `textlayer:true` |
| `offline` | Matches offline media | `offline:true` |
| `proxy` | Matches clips using a proxy file | `proxy:true` |
| `hasmarkers` | Matches clips containing timeline markers | `hasmarkers:true` |
| `has_effects` | Matches clips that have any video/audio effects applied | `has_effects:true` |
| `animpresets` / `haskeyframes` | Matches clips with animated properties/keyframes | `haskeyframes:true` |
| `motionmodified` | Matches clips where Scale $\neq$ 100%, Rotation $\neq$ 0, or Position $\neq$ 960,540 | `motionmodified:true` |
| `audioeffects` | Matches audio clips containing audio effects | `audioeffects:true` |
| `lumetri` | Matches clips with the Lumetri Color effect applied | `lumetri:true` |
| `hascolorlabel` | Matches clips that have an assigned color label | `hascolorlabel:true` |
| `hasfonts` | Matches clips containing text or title layers | `hasfonts:true` |
| `hascamera` | Matches clips that have camera metadata | `hascamera:true` |
| `hasresolution` | Matches clips with resolution metadata | `hasresolution:true` |
| `hasfps` | Matches clips with frame rate metadata | `hasfps:true` |
| `hascodec` | Matches clips with codec metadata | `hascodec:true` |

### 3. Project Asset Filters (`asset:<value>`)

Filters project assets matching specific file statuses:

| Key | Supported Values & Meanings | Example |
| :--- | :--- | :--- |
| `asset:offline` | Clip is offline | `asset:offline` |
| `asset:proxy` | Clip has an active proxy | `asset:proxy` |
| `asset:unused` | Asset exists in project bin but has `0` sequence usage | `asset:unused` |
| `asset:file` | Asset is a raw file | `asset:file` |
| `asset:bin` | Asset is a project bin (folder) | `asset:bin` |
| `asset:duplicate` | Identifies duplicate assets used across the project (matched by file path) | `asset:duplicate` |
| `asset:missingfont` | Placeholder (currently returns no matches) | `asset:missingfont` |

---

## ⚡ Smart Resolver (Dynamic Effect Parameters)

Universal Search dynamically parses applied effect parameters that are not hardcoded. When a user searches for an effect parameter, it matches it to the selected effect chip.

### Common Premiere Pro Effects & Parameter Query Examples

| Effect Name | Example Parameters | Example Query |
| :--- | :--- | :--- |
| **Lumetri Color** | `exposure`, `contrast`, `highlights`, `shadows`, `whites`, `blacks`, `saturation`, `temperature`, `tint` | `effect:"Lumetri Color" exposure > 1.5` |
| **Gaussian Blur** | `blurriness`, `blurdimensions`, `repeatedgepixels` | `effect:"Gaussian Blur" blurriness > 25` |
| **Crop** | `left`, `top`, `right`, `bottom`, `zoom` | `effect:"Crop" left > 10` |
| **Transform** | `scale`, `skew`, `rotation`, `opacity`, `position` | `effect:"Transform" skew != 0` |
| **Ultra Key** | `setting`, `color`, `translucency`, `pedestal`, `chokemidtone` | `effect:"Ultra Key" pedestal > 10` |
| **ProcAmp** | `brightness`, `contrast`, `hue`, `saturation` | `effect:"ProcAmp" brightness > 10` |

*Note: Suffixes `bypass` (or `bypass<effectname>`) can be queried with boolean flags (e.g. `bypass:true` or `bypass:false`).*

---

## 🤖 AI Natural Language Translation Mappings

When the **AI Toggle** is active, plain English terms are dynamically translated into structured query filters before being executed:

| Input Phrase | Translated Query |
| :--- | :--- |
| `gaussian blur` or `blur` | `effect:"Gaussian Blur"` |
| `warp stab` | `effect:"Warp Stabilizer"` |
| `lumetri` or `color correct` | `effect:"Lumetri Color"` |
| `sharpen` | `effect:"Sharpen"` |
| `ultra key` or `chroma key` or `green screen` | `effect:"Ultra Key"` |
| `cross dissolve` | `effect:"Cross Dissolve"` |
| `dip to black` | `effect:"Dip to Black"` |
| `loud audio` or `loud clip` or `loud` | `volume>6` |
| `quiet` or `silent` or `low volume` | `volume<-6` |
| `4k` or `uhd` | `resolution:4K` |
| `1080` or `full hd` | `resolution:1080` |
| `offline` or `missing` | `offline:true` |
| `nested` or `nest` | `nested:true` |
| `proxy` or `proxies` | `proxy:true` |
| `no proxy` | `proxy:false` |
| `scaled` or `zoomed` or `zoom` | `scale>100` |
| `transparent` or `faded` | `opacity<100` |
| `rotated` | `rotation!=0` |
| `longer than [X]s` / `[X]m` | `duration>[X]` (converts minutes to seconds) |
| `shorter than [X]s` / `[X]m` | `duration<[X]` (converts minutes to seconds) |
| `find/show/where/which/clips with [X]` | `effect:"[X]"` |

---

## ⌨️ Command Palette Commands & Shortcuts

Press **`Ctrl+P`** (Windows) or **`⌘P`** (Mac) to open the Command Palette. Type a command to search and execute:

| Command | Action | Keyboard Shortcut |
| :--- | :--- | :--- |
| **Select All Matches** | Selects all matched clips in active sequence | `Enter` (inside palette) |
| **Reveal First Match in Timeline** | Focuses/reveals the first match in sequence | `Alt+R` |
| **Export Search Results CSV** | Exports search result columns to CSV file | `Shift+E` |
| **Toggle AI Natural Language Search** | Toggles natural language query translation | `Alt+A` |
| **Save Current Search** | Saves query pattern to saved queries list | `Ctrl+S` |
| **Run Performance Scanner** | Switches view to Performance Scanner dashboard | `Alt+S` |
| **Show Project Analytics** | Switches view to Project Analytics dashboard | `Alt+D` |
| **Reset All Search Fields** | Clears the active search query | `Esc` |
| **Batch: Set Volume on Matches** | Prompts to change volume dB of matches | `Alt+V` |
| **Batch: Set Scale on Matches** | Prompts to change scale % of matches | `Alt+Z` |
| **Batch: Set Opacity on Matches** | Prompts to change opacity % of matches | `Alt+O` |
| **Batch: Rename Matches** | Prompts to batch rename matched clips | `Alt+N` |

---

## 🚫 Unsupported or Pending Keys

These keys are recognized by the parser but not yet fully backed by backend data (they will trigger an "Unsupported Key" notification in the search UI instead of silently failing):

* `intensity`
* `font`
* `color`
* `transition`
* `rendercost`
* `motion`
* `created`
* `favorite` (not implemented on backend)
* `aspectratio`
* `exportpreset`

---

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

---

## 📚 For Developers
If you are looking to understand the codebase, API limits, or the Smart Resolver query logic, please read the [Developer Guide & API Reference](DEVELOPER_GUIDE.md).
