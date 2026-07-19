// Universal Search — mini timeline

let pxPerSecond = 12;
let hoveredClipId = null;

function renderTimeline(clips, activeSequenceName, matchIds, selectedIds, playheadSeconds) {
  const container = document.getElementById("timeline");
  const gutter = document.getElementById("tl-gutter");
  if(!container || !gutter) return;
  
  container.innerHTML = "";
  gutter.innerHTML = '<div class="tl-track-label" style="height:20px;border-bottom:1px solid var(--border-soft)"></div>';

  const seqClips = clips.filter(c => c.sequenceName === activeSequenceName);
  if (seqClips.length === 0) {
    container.innerHTML = '<div style="padding:10px;color:#777;">No clips in active sequence, or nothing open.</div>';
    return;
  }

  const maxEnd = Math.max(...seqClips.map(c => c.end), 1);
  const trackKeys = [...new Set(seqClips.map(c => c.trackType + c.trackIndex))].sort((a,b) => b.localeCompare(a)); // Reverse sort to have V tracks on top

  // Draw ruler
  const ruler = document.createElement("div");
  ruler.className = "tl-ruler";
  ruler.style.width = Math.max(maxEnd * pxPerSecond + 60, 300) + "px";
  for(let s=0; s<=maxEnd; s+=60) {
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.style.left = (s * pxPerSecond + 20) + "px";
    
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    tick.textContent = `00:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:00`;
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
    row.style.width = Math.max(maxEnd * pxPerSecond + 60, 300) + "px";

    seqClips.filter(c => (c.trackType + c.trackIndex) === tk).forEach(c => {
      const block = document.createElement("div");
      block.className = "clip-block " + (c.trackType === "A" ? "a" : (c.nested ? "adj" : "v"));
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
    ph.style.height = ((trackKeys.length * 36) + 20) + "px"; // 36px per row + 20px ruler
    container.appendChild(ph);
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
  
  // Quick inline styles for tooltip so it doesn't look completely broken if CSS is missing
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
  const zoomIn = document.getElementById("zoom-in");
  const zoomOut = document.getElementById("zoom-out");
  if(zoomIn) zoomIn.addEventListener("click", () => {
    pxPerSecond = Math.min(pxPerSecond * 1.4, 200);
    window.ffsRerenderTimeline();
  });
  if(zoomOut) zoomOut.addEventListener("click", () => {
    pxPerSecond = Math.max(pxPerSecond / 1.4, 2);
    window.ffsRerenderTimeline();
  });
});
