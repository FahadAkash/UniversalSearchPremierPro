// Universal Search — mini timeline

let pxPerSecond = 12;
const MIN_PPS = 2;
const MAX_PPS = 200;
let hoveredClipId = null;

function renderTimeline(clips, activeSequenceName, matchIds, selectedIds, playheadSeconds) {
  const container = document.getElementById("timeline");
  const gutter = document.getElementById("tl-gutter");
  if(!container || !gutter) return;
  
  container.innerHTML = "";
  gutter.innerHTML = '<div class="tl-track-label" style="height:20px;border-bottom:1px solid var(--border-soft)"></div>';

  const seqClips = clips.filter(c => c.sequenceName === activeSequenceName && c.trackType !== "S");
  if (seqClips.length === 0) {
    container.innerHTML = '<div style="padding:10px;color:#777;">No clips in active sequence, or nothing open.</div>';
    return;
  }

  const maxEnd = Math.max(...seqClips.map(c => c.end), 1);
  const trackKeys = [...new Set(seqClips.map(c => c.trackType + c.trackIndex))].sort((a,b) => {
    // Sort: V tracks descending (V3, V2, V1), then A tracks ascending (A1, A2, A3)
    const aType = a[0], bType = b[0];
    if (aType === bType) {
      const aIdx = parseInt(a.slice(1)), bIdx = parseInt(b.slice(1));
      return aType === "V" ? bIdx - aIdx : aIdx - bIdx;
    }
    return aType === "V" ? -1 : 1;
  });

  // Draw ruler with adaptive tick spacing
  const ruler = document.createElement("div");
  ruler.className = "tl-ruler";
  const totalWidth = Math.max(maxEnd * pxPerSecond + 60, 300);
  ruler.style.width = totalWidth + "px";

  // Adaptive tick interval based on zoom level
  let tickInterval;
  if (pxPerSecond >= 80) tickInterval = 5;
  else if (pxPerSecond >= 30) tickInterval = 10;
  else if (pxPerSecond >= 12) tickInterval = 30;
  else if (pxPerSecond >= 5) tickInterval = 60;
  else tickInterval = 120;

  for(let s = 0; s <= maxEnd; s += tickInterval) {
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.style.left = (s * pxPerSecond + 20) + "px";
    
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = Math.floor(s % 60);
    tick.textContent = `${hrs.toString().padStart(2,'0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:00`;
    ruler.appendChild(tick);
  }
  container.appendChild(ruler);

  trackKeys.forEach(tk => {
    // Add track label to gutter
    const label = document.createElement("div");
    label.className = "tl-track-label" + (tk.startsWith('A') ? " audio" : "");
    label.textContent = tk;
    gutter.appendChild(label);

    // Add track row to container
    const row = document.createElement("div");
    row.className = "tl-row";
    row.style.width = totalWidth + "px";

    seqClips.filter(c => (c.trackType + c.trackIndex) === tk).forEach(c => {
      const block = document.createElement("div");
      block.dataset.clipId = c.id;
      block.className = "clip-block " + (c.trackType === "A" ? "a" : ((c.nested || c.adjustment) ? "adj" : "v"));
      if (matchIds.has(c.id)) block.classList.add("match");
      if (selectedIds.has(c.id)) block.classList.add("selected");
      if (hoveredClipId === c.id) block.classList.add("hovered");
      block.style.left = (20 + c.start * pxPerSecond) + "px";
      block.style.width = Math.max((c.end - c.start) * pxPerSecond, 4) + "px";
      block.textContent = c.name;
      block.title = "";

      block.addEventListener("mouseenter", (e) => {
        hoveredClipId = c.id;
        block.classList.add("hovered");
        showTooltip(e, c);
      });
      block.addEventListener("mousemove", (e) => moveTooltip(e));
      block.addEventListener("mouseleave", () => {
        hoveredClipId = null;
        hideTooltip();
      });
      block.addEventListener("click", (e) => {
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        window.ffsOnTimelineClipClick(c.id, additive);
      });

      row.appendChild(block);
    });

    container.appendChild(row);
  });

  if (typeof playheadSeconds === "number") {
    const ph = document.createElement("div");
    ph.className = "playhead";
    ph.style.left = (20 + playheadSeconds * pxPerSecond) + "px";
    ph.style.height = ((trackKeys.length * 36) + 20) + "px";
    container.appendChild(ph);
  }

  // Update timecode display in toolbar
  if (typeof playheadSeconds === "number") {
    const tcEl = document.querySelector(".tl-toolbar .meta.mono");
    if (tcEl) {
      const ph = playheadSeconds;
      const phH = Math.floor(ph / 3600);
      const phM = Math.floor((ph % 3600) / 60);
      const phS = Math.floor(ph % 60);
      const phF = Math.floor((ph % 1) * 24);
      const endH = Math.floor(maxEnd / 3600);
      const endM = Math.floor((maxEnd % 3600) / 60);
      const endS = Math.floor(maxEnd % 60);
      const endF = Math.floor((maxEnd % 1) * 24);
      tcEl.textContent = `${phH.toString().padStart(2,'0')}:${phM.toString().padStart(2,'0')}:${phS.toString().padStart(2,'0')}:${phF.toString().padStart(2,'0')} / ${endH.toString().padStart(2,'0')}:${endM.toString().padStart(2,'0')}:${endS.toString().padStart(2,'0')}:${endF.toString().padStart(2,'0')}`;
    }
  }

  // Sync scroll positions
  syncScroll();
  updateZoomSlider();
}

// ---- Scroll sync between gutter and tracks ----
function syncScroll() {
  const tracks = document.getElementById("timeline");
  const gutter = document.getElementById("tl-gutter");
  if (!tracks || !gutter) return;

  // Remove old listeners to avoid stacking
  tracks._ffsScrollHandler && tracks.removeEventListener("scroll", tracks._ffsScrollHandler);

  tracks._ffsScrollHandler = () => {
    gutter.scrollTop = tracks.scrollTop;
  };
  tracks.addEventListener("scroll", tracks._ffsScrollHandler);
}

// ---- Zoom slider ----
function getZoomPercent() {
  // Convert pxPerSecond to a 0–100% scale (logarithmic)
  const logMin = Math.log(MIN_PPS);
  const logMax = Math.log(MAX_PPS);
  const logCur = Math.log(pxPerSecond);
  return ((logCur - logMin) / (logMax - logMin)) * 100;
}

function setZoomFromPercent(pct) {
  pct = Math.max(0, Math.min(100, pct));
  const logMin = Math.log(MIN_PPS);
  const logMax = Math.log(MAX_PPS);
  pxPerSecond = Math.exp(logMin + (pct / 100) * (logMax - logMin));
  pxPerSecond = Math.max(MIN_PPS, Math.min(MAX_PPS, pxPerSecond));
  updateZoomSlider();
  window.ffsRerenderTimeline();
}

function updateZoomSlider() {
  const knob = document.querySelector(".zoom-track i");
  if (knob) {
    knob.style.left = getZoomPercent() + "%";
  }
}

let tooltipEl = null;
function showTooltip(e, clip) {
  hideTooltip();
  tooltipEl = document.createElement("div");
  tooltipEl.className = "clip-tooltip";
  tooltipEl.innerHTML =
    `<b>${escapeHtml(clip.name)}</b><br>` +
    `Sequence: ${escapeHtml(clip.sequenceName)}<br>` +
    `Track: ${clip.trackType}${clip.trackIndex}<br>` +
    `Timecode: ${clip.start.toFixed(2)}s – ${clip.end.toFixed(2)}s<br>` +
    `Duration: ${clip.duration.toFixed(2)}s<br>` +
    `Effects: ${clip.effects.length ? escapeHtml(clip.effects.join(", ")) : "none"}`;
  
  tooltipEl.style.position = "fixed";
  tooltipEl.style.background = "var(--bg-panel-2)";
  tooltipEl.style.border = "1px solid var(--border)";
  tooltipEl.style.padding = "8px";
  tooltipEl.style.borderRadius = "6px";
  tooltipEl.style.boxShadow = "0 4px 12px rgba(0,0,0,0.5)";
  tooltipEl.style.zIndex = "9999";
  tooltipEl.style.pointerEvents = "none";
  tooltipEl.style.fontSize = "11px";
  tooltipEl.style.lineHeight = "1.4";
  
  document.body.appendChild(tooltipEl);
  moveTooltip(e);
}
function moveTooltip(e) {
  if (!tooltipEl) return;
  tooltipEl.style.left = (e.clientX + 14) + "px";
  tooltipEl.style.top = (e.clientY + 14) + "px";
}
function hideTooltip() {
  if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

document.addEventListener("DOMContentLoaded", () => {
  // Zoom buttons
  const zoomIn = document.getElementById("zoom-in");
  const zoomOut = document.getElementById("zoom-out");
  if(zoomIn) zoomIn.addEventListener("click", () => {
    pxPerSecond = Math.min(pxPerSecond * 1.4, MAX_PPS);
    updateZoomSlider();
    window.ffsRerenderTimeline();
  });
  if(zoomOut) zoomOut.addEventListener("click", () => {
    pxPerSecond = Math.max(pxPerSecond / 1.4, MIN_PPS);
    updateZoomSlider();
    window.ffsRerenderTimeline();
  });

  // Zoom slider track — click to set zoom
  const zoomTrack = document.querySelector(".zoom-track");
  if (zoomTrack) {
    zoomTrack.addEventListener("click", (e) => {
      const rect = zoomTrack.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setZoomFromPercent(pct);
    });

    // Drag support for the slider
    let dragging = false;
    zoomTrack.addEventListener("mousedown", (e) => {
      dragging = true;
      e.preventDefault();
      const rect = zoomTrack.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setZoomFromPercent(pct);
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const rect = zoomTrack.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setZoomFromPercent(pct);
    });
    document.addEventListener("mouseup", () => { dragging = false; });
  }

  // Mouse wheel zoom on the timeline area
  const tlBody = document.querySelector(".tl-body");
  if (tlBody) {
    tlBody.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) {
          pxPerSecond = Math.min(pxPerSecond * 1.15, MAX_PPS);
        } else {
          pxPerSecond = Math.max(pxPerSecond / 1.15, MIN_PPS);
        }
        updateZoomSlider();
        window.ffsRerenderTimeline();
      }
    }, { passive: false });
  }

  // Initial slider position
  updateZoomSlider();
});

// --- Timeline Resizer Logic ---
const tlResizer = document.getElementById('tl-resizer');
const timelineContainer = document.getElementById('timeline-container');
let isResizingTimeline = false;
let startY = 0;
let startHeight = 0;

if (tlResizer && timelineContainer) {
  tlResizer.addEventListener('mousedown', (e) => {
    isResizingTimeline = true;
    startY = e.clientY;
    startHeight = timelineContainer.getBoundingClientRect().height;
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizingTimeline) return;
    const dy = startY - e.clientY;
    const newHeight = startHeight + dy;
    // Limit height between 100px and 80% of window height
    if (newHeight > 100 && newHeight < window.innerHeight * 0.8) {
      timelineContainer.style.height = newHeight + 'px';
      // Rerender timeline canvas if needed
      if (window.ffsRerenderTimeline) window.ffsRerenderTimeline();
    }
  });

  document.addEventListener('mouseup', () => {
    if (isResizingTimeline) {
      isResizingTimeline = false;
      document.body.style.cursor = '';
    }
  });
}

window.fastUpdateHighlight = function() {
  document.querySelectorAll('.clip-block').forEach(block => {
    const id = block.dataset.clipId;
    if (!id) return;
    
    if (typeof selectedIds !== 'undefined' && selectedIds.has(id)) {
      block.classList.add('selected');
    } else {
      block.classList.remove('selected');
    }
    
    if (typeof hoveredClipId !== 'undefined' && hoveredClipId === id) {
      block.classList.add('hovered');
    } else {
      block.classList.remove('hovered');
    }
  });

  document.querySelectorAll('#results tr').forEach(tr => {
    const id = tr.dataset.clipId;
    if (!id) return;
    
    if (typeof selectedIds !== 'undefined' && selectedIds.has(id)) {
      tr.classList.add('selected');
      if (!tr.classList.contains('match-glow')) {
         tr.classList.add('match-glow');
      }
    } else {
      tr.classList.remove('selected');
      if (!matchIds.has(id)) tr.classList.remove('match-glow');
    }
  });
};

window.pulseTimelineClip = function(clipId) {
  const block = document.querySelector('.clip-block[data-clip-id="' + clipId + '"]');
  if (block) {
    // Scroll into view gently
    block.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    
    // Play pulse animation
    block.classList.remove('pulse-highlight'); // reset if already animating
    void block.offsetWidth; // trigger reflow
    block.classList.add('pulse-highlight');
    
    setTimeout(() => {
      if (block) block.classList.remove('pulse-highlight');
    }, 1000);
  }
};
