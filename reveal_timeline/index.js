const ppro = require("premierepro");

const statusEl = document.getElementById("status");
const btn = document.getElementById("revealBtn");
const autoToggle = document.getElementById("autoToggle");

let lastSelectionKey = null;
let pollTimer = null;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#ff6b6b" : "#8fd3ff";
}

function matchesProjectItem(candidate, target) {
  if (candidate.nodeId && target.nodeId) return candidate.nodeId === target.nodeId;
  return candidate.name === target.name;
}

async function collectTrackItemsForItem(sequence, target) {
  const matches = [];
  const videoTrackCount = await sequence.getVideoTrackCount();
  const audioTrackCount = await sequence.getAudioTrackCount();

  for (let i = 0; i < videoTrackCount; i++) {
    const track = await sequence.getVideoTrack(i);
    const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    for (const ti of items) {
      const pi = await ti.getProjectItem();
      if (pi && matchesProjectItem(pi, target)) matches.push(ti);
    }
  }

  for (let i = 0; i < audioTrackCount; i++) {
    const track = await sequence.getAudioTrack(i);
    const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    for (const ti of items) {
      const pi = await ti.getProjectItem();
      if (pi && matchesProjectItem(pi, target)) matches.push(ti);
    }
  }

  return matches;
}

async function revealSelectedClip() {
  try {
    const project = await ppro.Project.getActiveProject();
    if (!project) return setStatus("No active project.", true);

    const sequence = await project.getActiveSequence();
    if (!sequence) return setStatus("Open a sequence first.", true);

    const projSelection = await ppro.ProjectUtils.getSelection();
    const selectedItems = await projSelection.getItems();
    if (!selectedItems || selectedItems.length === 0) {
      return setStatus("Select a clip in the Project panel first.", true);
    }

    const target = selectedItems[0];
    const matches = await collectTrackItemsForItem(sequence, target);

    if (matches.length === 0) {
      return setStatus(`"${target.name}" isn't used in the active sequence.`, true);
    }

    // Sort occurrences by their position on the timeline.
    const withTimes = [];
    for (const ti of matches) {
      const start = await ti.getStartTime();
      withTimes.push({ ti, ticks: Number(start.ticks ?? start.seconds ?? 0) });
    }
    withTimes.sort((a, b) => a.ticks - b.ticks);

    // Select every occurrence in the timeline.
    const newSelection = await new Promise((resolve) => {
      ppro.TrackItemSelection.createEmptySelection((sel) => resolve(sel));
    });
    for (const { ti } of withTimes) newSelection.addItem(ti, true);
    sequence.setSelection(newSelection);

    // Jump the playhead to the earliest occurrence.
    const firstStart = await withTimes[0].ti.getStartTime();
    await sequence.setPlayerPosition(firstStart);

    setStatus(
      matches.length === 1
        ? `Jumped to "${target.name}".`
        : `Selected ${matches.length} instances of "${target.name}" — jumped to the first.`
    );
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message || err}`, true);
  }
}

btn.addEventListener("click", revealSelectedClip);

// --- Optional auto mode: polls the Project panel selection and reveals
// automatically the moment it changes, so you never have to click at all. ---
async function pollSelection() {
  try {
    const project = await ppro.Project.getActiveProject();
    if (!project) return;
    const projSelection = await ppro.ProjectUtils.getSelection();
    const items = await projSelection.getItems();
    const key = items && items.length ? (items[0].nodeId || items[0].name) : null;

    if (key && key !== lastSelectionKey) {
      lastSelectionKey = key;
      await revealSelectedClip();
    } else if (!key) {
      lastSelectionKey = null;
    }
  } catch (err) {
    // Stay quiet during polling errors (e.g. no project open yet).
  }
}

autoToggle.addEventListener("change", () => {
  if (autoToggle.checked) {
    setStatus("Auto-reveal on — change your Project panel selection.");
    pollTimer = setInterval(pollSelection, 400);
  } else {
    clearInterval(pollTimer);
    pollTimer = null;
    setStatus("Auto-reveal off.");
  }
});
