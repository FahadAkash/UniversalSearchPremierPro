// Universal Search — main panel controller
// Polls the ExtendScript host for the current project state.

const csInterface = new CSInterface();
const POLL_MS = 2000;

let lastSnapshot = [];
let lastQuery = "";
let matchIds = new Set();
let selectedIds = new Set();
let activeSequenceName = null;
let playheadSeconds = 0;
let aiSearchEnabled = false;
let autoSelectEnabled = true;
let searchDebounceTimer = null;
let lastLayerData = null;
let knownEffects = [];
let currentView = 'table';
let projectStats = null;
let projectName = "Loading...";
let savedSearches = [];

// Load saved searches from localStorage
try { savedSearches = JSON.parse(localStorage.getItem("ffs_savedSearches") || "[]"); } catch(e) {}

// Command Palette commands list
const COMMANDS = [
  { name: "Select All Matches", action: "select-all", shortcut: "Enter" },
  { name: "Reveal First Match in Timeline", action: "reveal-first", shortcut: "Alt+R" },
  { name: "Export Search Results CSV", action: "export", shortcut: "Shift+E" },
  { name: "Toggle AI Natural Language Search", action: "toggle-ai", shortcut: "Alt+A" },
  { name: "Save Current Search", action: "save-search", shortcut: "Ctrl+S" },
  { name: "Run Performance Scanner", action: "perf-scan", shortcut: "Alt+S" },
  { name: "Show Project Analytics", action: "analytics", shortcut: "Alt+D" },
  { name: "Reset All Search Fields", action: "reset", shortcut: "Esc" },
  { name: "Batch: Set Volume on Matches", action: "batch-volume", shortcut: "Alt+V" },
  { name: "Batch: Set Scale on Matches", action: "batch-scale", shortcut: "Alt+Z" },
  { name: "Batch: Set Opacity on Matches", action: "batch-opacity", shortcut: "Alt+O" },
  { name: "Batch: Rename Matches", action: "batch-rename", shortcut: "Alt+N" },
];
let selectedCmdIndex = 0;

function evalHost(fn, ...args) {
  return new Promise((resolve) => {
    const argStr = args.map(a => JSON.stringify(a)).join(",");
    csInterface.evalScript(`${fn}(${argStr})`, (result) => {
      try { resolve(JSON.parse(result)); }
      catch (e) { resolve(result); }
    });
  });
}

// AI search mapping rules (Natural Language Parser)
function translateAILanguage(input) {
  const lower = input.toLowerCase().trim();
  if (!lower) return "";

  // Effect-related
  if (/gaussian\s*blur|blur/i.test(lower)) return 'effect:"Gaussian Blur"';
  if (/warp\s*stab/i.test(lower)) return 'effect:"Warp Stabilizer"';
  if (/lumetri|color\s*correct/i.test(lower)) return 'effect:"Lumetri Color"';
  if (/sharpen/i.test(lower)) return 'effect:"Sharpen"';
  if (/ultra\s*key|chroma\s*key|green\s*screen/i.test(lower)) return 'effect:"Ultra Key"';
  if (/cross\s*dissolve/i.test(lower)) return 'effect:"Cross Dissolve"';
  if (/dip\s*to\s*black/i.test(lower)) return 'effect:"Dip to Black"';

  // Property queries
  if (/loud\s*audio|loud\s*clip|loud/i.test(lower)) return 'volume>6';
  if (/quiet|silent|low\s*volume/i.test(lower)) return 'volume<-6';
  if (/4k|uhd/i.test(lower)) return 'resolution:4K';
  if (/1080|full\s*hd/i.test(lower)) return 'resolution:1080';
  if (/offline|missing/i.test(lower)) return 'offline:true';
  if (/nested|nest/i.test(lower)) return 'nested:true';
  if (/proxy|proxies/i.test(lower)) return 'proxy:true';
  if (/no\s*proxy/i.test(lower)) return 'proxy:false';
  if (/scaled|zoomed|zoom/i.test(lower)) return 'scale>100';
  if (/transparent|faded/i.test(lower)) return 'opacity<100';
  if (/rotated/i.test(lower)) return 'rotation!=0';

  // Duration queries
  const durMatch = lower.match(/longer\s+than\s+(\d+)\s*(s|sec|m|min)?/);
  if (durMatch) {
    const val = parseInt(durMatch[1]);
    const unit = durMatch[2];
    return `duration>${unit && (unit === 'm' || unit === 'min') ? val * 60 : val}`;
  }
  const shortMatch = lower.match(/shorter\s+than\s+(\d+)\s*(s|sec|m|min)?/);
  if (shortMatch) {
    const val = parseInt(shortMatch[1]);
    const unit = shortMatch[2];
    return `duration<${unit && (unit === 'm' || unit === 'min') ? val * 60 : val}`;
  }

  // Find clips with specific effect
  const fxMatch = lower.match(/(?:find|show|where|which|clips?\s+with)\s+(.+)/i);
  if (fxMatch) return `effect:"${fxMatch[1]}"`;

  return lower; // fallback
}
let isPolling = false;
let lastInteractionTime = 0;

// Track user interactions to pause polling, keeping ExtendScript engine free for instant selection
document.addEventListener("mousemove", () => { lastInteractionTime = Date.now(); });
document.addEventListener("keydown", () => { lastInteractionTime = Date.now(); });
document.addEventListener("click", () => { lastInteractionTime = Date.now(); });

async function pollProject() {
  if (isPolling) return;
  // If the user has interacted within the last 1500ms, skip polling
  if (Date.now() - lastInteractionTime < 1500) return;
  
  isPolling = true;
  try {
    const t0 = performance.now();
    const [snapshotJson, stateJson] = await Promise.all([
      evalHost("ffs_getProjectSnapshot"),
      evalHost("ffs_getActiveState")
    ]);
    const searchTime = (performance.now() - t0).toFixed(0);

    // Update search timing
    const speedEl = document.querySelector(".stat-pill.speed b");
    if (speedEl) speedEl.textContent = searchTime + "ms";

    const indicator = document.getElementById("live-indicator");
    const state = stateJson;
    if (state && state.connected) {
      indicator.innerHTML = '<span class="dot"></span> Live Connected';
      indicator.style.opacity = "1";
      activeSequenceName = state.sequence;
      playheadSeconds = state.playhead || 0;

      // Update project name dynamically
      if (state.projectName && state.projectName !== projectName) {
        projectName = state.projectName;
        const projChip = document.querySelector(".project-chip b");
        if (projChip) projChip.textContent = projectName;
      }

      // Update sequence info in timeline
      const tlTitle = document.querySelector(".tl-toolbar .title");
      if (tlTitle && state.sequence) {
        tlTitle.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M7 6v12M17 6v12"/></svg> ${escapeHtmlMain(state.sequence)}`;
      }
      const tlMeta = document.querySelector(".tl-toolbar .meta");
      if (tlMeta) {
        const trackCount = (state.videoTracks || 0) + (state.audioTracks || 0);
        const matchCount = [...matchIds].filter(id => {
          const c = lastSnapshot.find(cl => cl.id === id);
          return c && c.sequenceName === activeSequenceName;
        }).length;
        tlMeta.textContent = `Synced live · ${trackCount} tracks · ${matchCount} matches highlighted`;
      }
    } else {
      indicator.innerHTML = '<span class="dot" style="background:var(--red); box-shadow:none;"></span> Disconnected';
      indicator.style.opacity = "0.7";
    }

    lastSnapshot = Array.isArray(snapshotJson) ? snapshotJson : [];
    
    // Hide scan bar if it's visible
    const scanBar = document.getElementById("scan-bar");
    if (scanBar && !scanBar.classList.contains("hidden")) {
      scanBar.classList.add("hidden");
    }

    runSearch(lastQuery, { rerenderOnly: true });
    window.ffsRerenderTimeline();
    updateAnalytics();
    updatePerformanceScanner();

    // Refresh layer data if visible
    if (currentView === 'layers') {
      renderLayerOverview();
    }
  } catch (err) {
    console.error("Error in pollProject:", err);
    // Ensure scan bar is hidden even on error
    const scanBar = document.getElementById("scan-bar");
    if (scanBar) scanBar.classList.add("hidden");
  } finally {
    isPolling = false;
  }
}

function runSearch(raw, opts = {}) {
  let searchVal = raw;
  if (aiSearchEnabled && raw) {
    searchVal = translateAILanguage(raw);
  }
  lastQuery = raw;
  const countEl = document.getElementById("result-count");
  const resultsEl = document.getElementById("results");
  const batchEl = document.getElementById("batch-actions");

  if (!raw || !raw.trim()) {
    if (!opts.rerenderOnly) {
      resultsEl.innerHTML = "";
      countEl.textContent = "Type a query to search the open project...";
      batchEl.classList.add("hidden");
      matchIds = new Set();
    }
    return;
  }

  const t0 = performance.now();
  const { results, unsupported } = runQuery(lastSnapshot, searchVal);
  const queryMs = (performance.now() - t0).toFixed(1);
  matchIds = new Set(results.map(r => r.id));

  let countText = `${results.length} matching clip${results.length === 1 ? "" : "s"}`;
  countText += ` · ${queryMs}ms`;
  if (unsupported.length) {
    countText += ` (note: ${unsupported.join(", ")} unsupported)`;
  }
  countEl.textContent = countText;

  batchEl.classList.toggle("hidden", results.length === 0);

  // Auto-select matching clips in the timeline (debounced)
  if (autoSelectEnabled && !opts.rerenderOnly && results.length > 0) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => autoSelectMatches(results), 50);
  }

  resultsEl.innerHTML = "";
  results.forEach(clip => {
    const item = document.createElement("tr");
    if (selectedIds.has(clip.id)) {
      item.className = "selected match-glow";
    } else {
      item.className = matchIds.has(clip.id) ? "match-glow" : "";
    }

    const typeClass = clip.trackType === "S" ? "adj" : (clip.trackType === "A" ? "audio" : ((clip.nested || clip.adjustment) ? "adj" : "video"));
    const typeIco = clip.trackType === "S"
      ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M7 6v12M17 6v12"/></svg>`
      : (clip.trackType === "A"
        ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`
        : `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`);

    const fxChips = clip.effects.map(fx => `<span class="fx-chip">${fx}</span>`).join("");
    const statusText = clip.offline ? `<span class="tag offline">● Offline</span>` : (clip.proxy ? `<span class="tag proxy">◐ Proxy</span>` : `<span class="tag online">● Online</span>`);
    const labelColor = clip.colorLabel ? `style="background:${clip.colorLabel}"` : '';

    // Compute render cost
    const fxCount = clip.effects.length;
    const hasWarp = clip.effects.some(e => e.toLowerCase().includes("warp stabilizer"));
    const costClass = hasWarp ? "high" : (fxCount > 3 ? "high" : (fxCount > 1 ? "med" : "low"));
    const costLabel = costClass === "high" ? "High" : (costClass === "med" ? "Med" : "Low");

    // Timecode formatting
    const tcMins = Math.floor(clip.start / 60);
    const tcSecs = Math.floor(clip.start % 60);
    const tcFrames = Math.round((clip.start % 1) * 24);
    const timecode = `${tcMins.toString().padStart(2,'0')}:${tcSecs.toString().padStart(2,'0')}:${tcFrames.toString().padStart(2,'0')}`;

    item.innerHTML = `
      <td><div class="cell-name"><span class="type-ico ${typeClass}">${typeIco}</span>${escapeHtmlMain(clip.name)}</div></td>
      <td>${escapeHtmlMain(clip.sequenceName)}</td>
      <td class="mono">${clip.trackType === "S" ? "Seq" : clip.trackType + clip.trackIndex}</td>
      <td class="mono">${clip.trackType === "S" ? "—" : timecode}</td>
      <td class="mono">${clip.trackType === "S" ? "—" : clip.duration.toFixed(2) + "s"}</td>
      <td>Scale</td><td class="mono">${clip.scale}%</td>
      <td>${statusText}</td>
      <td>${fxChips || '—'}</td>
      <td><span class="cost ${costClass}"><i class="cost-dot"></i>${costLabel}</span></td>
      <td><span class="lbl-dot" ${labelColor}></span></td>
      <td class="mono">Now</td>
    `;
    item.addEventListener("click", (e) => {
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      selectClip(clip, additive);
    });
    item.addEventListener("mouseenter", () => { hoveredClipId = clip.id; window.ffsRerenderTimeline(); });
    item.addEventListener("mouseleave", () => { hoveredClipId = null; window.ffsRerenderTimeline(); });
    resultsEl.appendChild(item);
  });
}

function selectClip(clip, additive) {
  if (!additive) selectedIds = new Set();
  selectedIds.add(clip.id);
  
  // Update local UI immediately so it feels instant
  updateInspector(clip);
  runSearch(lastQuery, { rerenderOnly: true });
  window.ffsRerenderTimeline();

  // Fire off ExtendScript selection in background without blocking the UI
  evalHost("ffs_selectClips", JSON.stringify(Array.from(selectedIds)));
}

// Update the dynamic inspector panel
function updateInspector(clip) {
  const inspector = document.getElementById("inspector-panel");
  if (!inspector || !clip) return;

  const thumbName = document.getElementById("insp-thumb-name");
  const thumbTag = document.getElementById("insp-thumb-tag");
  if (thumbName) thumbName.textContent = clip.name;
  
  // Show file path or sequence metadata
  let metaTag = `${clip.duration.toFixed(2)}s · ${clip.resolution || '1080p'} · ${clip.fps || '23.97'}`;
  if (clip.mediaPath) {
    metaTag = clip.mediaPath.split(/[\\/]/).pop() + " · " + metaTag;
  }
  if (thumbTag) thumbTag.textContent = metaTag;

  const propertiesSec = document.getElementById("insp-motion");
  if (propertiesSec) {
    propertiesSec.innerHTML = `
      <div class="insp-section-title">Motion</div>
      <div class="prop-row"><span class="k">Position</span><span class="v">${clip.position || '960, 540'}</span></div>
      <div class="prop-row withmeter"><span class="k">Scale</span><span class="v">${clip.scale || 100}%<span class="meter"><i style="width:${Math.min(clip.scale || 100, 100)}%"></i></span></span></div>
      <div class="prop-row"><span class="k">Rotation</span><span class="v">${clip.rotation || 0}°</span></div>
      <div class="prop-row withmeter"><span class="k">Opacity</span><span class="v">${clip.opacity || 100}%<span class="meter"><i style="width:${clip.opacity || 100}%"></i></span></span></div>
    `;
  }

  const audioSec = document.getElementById("insp-audio");
  if (audioSec) {
    audioSec.innerHTML = `
      <div class="insp-section-title">Audio</div>
      <div class="prop-row withmeter"><span class="k">Volume</span><span class="v">${clip.volume || 0} dB<span class="meter"><i style="width:${Math.min(100, Math.max(0, (clip.volume || 0) + 12) * 4)}%"></i></span></span></div>
    `;
  }

  // Update Effects section
  const effectsSec = document.getElementById("insp-effects");
  if (effectsSec) {
    let effectsHtml = '<div class="insp-section-title">Effects</div>';
    if (clip.effects && clip.effects.length > 0) {
      clip.effects.forEach(fx => {
        const isHeavy = fx.toLowerCase().includes("warp") || fx.toLowerCase().includes("lumetri");
        effectsHtml += `<div class="prop-row"><span class="k">● ${escapeHtmlMain(fx)}</span><span class="v" style="color:${isHeavy ? 'var(--red)' : 'var(--text-2)'}">${isHeavy ? 'Heavy' : 'Light'}</span></div>`;
      });
    } else {
      effectsHtml += '<div class="prop-row"><span class="k" style="color:var(--text-3)">No effects applied</span></div>';
    }
    effectsSec.innerHTML = effectsHtml;
  }

  // Update Usage section
  const usageSec = document.getElementById("insp-usage");
  if (usageSec) {
    const usages = lastSnapshot.filter(c => c.name === clip.name);
    let usageHtml = `<div class="insp-section-title">Usage — ${usages.length} instances</div>`;
    usages.forEach(u => {
      usageHtml += `<div class="usage-item"><span class="name">${escapeHtmlMain(u.sequenceName)}</span><span class="count">${u.trackType}${u.trackIndex} · ${(u.start/60).toFixed(0).padStart(2,'0')}:${(u.start%60).toFixed(2).padStart(5,'0')}</span></div>`;
    });
    usageSec.innerHTML = usageHtml;
  }
}

// Project Analytics — update sidebar badges with real counts
function updateAnalytics() {
  const stats = {
    totalClips: lastSnapshot.length,
    videoClips: lastSnapshot.filter(c => c.trackType === "V").length,
    audioClips: lastSnapshot.filter(c => c.trackType === "A").length,
    sequences: lastSnapshot.filter(c => c.trackType === "S").length,
    nestedCount: lastSnapshot.filter(c => c.nested).length,
    adjustmentCount: lastSnapshot.filter(c => c.adjustment).length,
    graphicCount: lastSnapshot.filter(c => c.isGraphic).length,
    captionCount: lastSnapshot.filter(c => c.isCaption).length,
    titleCount: lastSnapshot.filter(c => c.isTitle).length,
    textCount: lastSnapshot.filter(c => c.isText).length,
    markerCount: lastSnapshot.filter(c => c.markerCount > 0).length,
    effectsCount: lastSnapshot.reduce((acc, c) => acc + c.effects.length, 0),
    offlineCount: lastSnapshot.filter(c => c.offline).length,
    proxyCount: lastSnapshot.filter(c => c.proxy).length,
    noProxyCount: lastSnapshot.filter(c => !c.proxy && c.trackType === "V" && !c.nested).length,
  };

  // Wire up sidebar badges dynamically
  document.querySelectorAll(".nav-item").forEach(item => {
    const text = item.textContent.trim();
    const cnt = item.querySelector(".cnt");
    if (!cnt) return;
    if (text.startsWith("All Results")) cnt.textContent = stats.totalClips;
    else if (text.startsWith("Video Clips")) cnt.textContent = stats.videoClips;
    else if (text.startsWith("Audio Clips")) cnt.textContent = stats.audioClips;
    else if (text.startsWith("Sequences")) cnt.textContent = stats.sequences;
    else if (text.startsWith("Nested")) cnt.textContent = stats.nestedCount;
    else if (text.startsWith("Adjustment")) cnt.textContent = stats.adjustmentCount;
    else if (text.startsWith("Essential Graphics")) cnt.textContent = stats.graphicCount;
    else if (text.startsWith("Captions")) cnt.textContent = stats.captionCount;
    else if (text.startsWith("Titles")) cnt.textContent = stats.titleCount;
    else if (text.startsWith("Text Layers")) cnt.textContent = stats.textCount;
    else if (text.startsWith("Markers")) cnt.textContent = stats.markerCount;
    else if (text.startsWith("Offline")) cnt.textContent = stats.offlineCount;
    else if (text.startsWith("Proxies")) cnt.textContent = stats.proxyCount;
    else if (text.startsWith("Effect Presets")) {
      var allFx = [];
      for (var idx = 0; idx < lastSnapshot.length; idx++) {
        var fxArr = lastSnapshot[idx].effects || [];
        for (var fxIdx = 0; fxIdx < fxArr.length; fxIdx++) {
          if (allFx.indexOf(fxArr[fxIdx]) === -1) {
            allFx.push(fxArr[fxIdx]);
          }
        }
      }
      cnt.textContent = allFx.length;
    }
    else if (text.startsWith("Keyframes")) cnt.textContent = stats.effectsCount;
  });
}

// Performance Bottleneck scanner
function updatePerformanceScanner() {
  const warpClips = lastSnapshot.filter(c => c.effects.some(e => e.toLowerCase().includes("warp stabilizer")));
  const heavyClips = lastSnapshot.filter(c => c.effects.length > 3);
  const missingProxy = lastSnapshot.filter(c => !c.proxy && c.trackType === "V" && !c.nested);

  const healthEl = document.querySelector('.nav-item .cnt[style*="green"]');
  if (healthEl) {
    const score = Math.max(0, 100 - warpClips.length * 8 - heavyClips.length * 3 - Math.floor(missingProxy.length / 10));
    healthEl.textContent = score;
  }
}

// ===================== COMMAND PALETTE =====================
function showCommandPalette() {
  const palette = document.getElementById("command-palette");
  if (!palette) return;
  palette.classList.remove("hidden");
  const input = document.getElementById("cmd-input");
  input.value = "";
  input.focus();
  selectedCmdIndex = 0;
  renderCommands("");
}

function hideCommandPalette() {
  const palette = document.getElementById("command-palette");
  if (palette) palette.classList.add("hidden");
}

function renderCommands(filterText) {
  const list = document.getElementById("cmd-list");
  list.innerHTML = "";
  const filtered = COMMANDS.filter(c => c.name.toLowerCase().includes(filterText.toLowerCase()));

  filtered.forEach((cmd, idx) => {
    const li = document.createElement("li");
    li.className = "cmd-item" + (idx === selectedCmdIndex ? " selected" : "");
    li.innerHTML = `${cmd.name} <span class="cmd-shortcut">${cmd.shortcut}</span>`;
    li.addEventListener("click", () => executeCommand(cmd));
    list.appendChild(li);
  });
}

async function executeCommand(cmd) {
  hideCommandPalette();
  const currentMatches = lastSnapshot.filter(c => matchIds.has(c.id));
  const ids = currentMatches.map(c => c.id);

  if (cmd.action === "select-all") {
    selectedIds = new Set(ids);
    await evalHost("ffs_selectClips", JSON.stringify(ids));
  } else if (cmd.action === "reveal-first") {
    if (currentMatches[0]) selectClip(currentMatches[0], false);
  } else if (cmd.action === "toggle-ai") {
    aiSearchEnabled = !aiSearchEnabled;
    document.querySelector(".ai-toggle").classList.toggle("active", aiSearchEnabled);
    runSearch(lastQuery);
  } else if (cmd.action === "export") {
    exportCSV(currentMatches);
  } else if (cmd.action === "reset") {
    document.getElementById("query").value = "";
    runSearch("");
  } else if (cmd.action === "save-search") {
    const q = document.getElementById("query").value.trim();
    if (q && !savedSearches.includes(q)) {
      savedSearches.push(q);
      localStorage.setItem("ffs_savedSearches", JSON.stringify(savedSearches));
      renderSavedSearches();
    }
  } else if (cmd.action === "analytics") {
    switchView("analytics");
  } else if (cmd.action === "perf-scan") {
    switchView("scanner");
  } else if (cmd.action === "batch-volume") {
    const val = prompt("Set volume (dB) for all matched audio clips:", "0");
    if (val !== null) {
      const audioIds = currentMatches.filter(c => c.trackType === "A").map(c => c.id);
      if (audioIds.length) await evalHost("ffs_batchAction", JSON.stringify(audioIds), "change-volume", val);
    }
  } else if (cmd.action === "batch-scale") {
    const val = prompt("Set scale (%) for all matched video clips:", "100");
    if (val !== null) {
      const videoIds = currentMatches.filter(c => c.trackType === "V").map(c => c.id);
      if (videoIds.length) await evalHost("ffs_batchAction", JSON.stringify(videoIds), "change-scale", val);
    }
  } else if (cmd.action === "batch-opacity") {
    const val = prompt("Set opacity (%) for all matched video clips:", "100");
    if (val !== null) {
      const videoIds = currentMatches.filter(c => c.trackType === "V").map(c => c.id);
      if (videoIds.length) await evalHost("ffs_batchAction", JSON.stringify(videoIds), "change-opacity", val);
    }
  } else if (cmd.action === "batch-rename") {
    const val = prompt("Rename all matched clips to:", "");
    if (val !== null && val.trim()) {
      await evalHost("ffs_batchAction", JSON.stringify(ids), "rename", val.trim());
    }
  }

  runSearch(lastQuery, { rerenderOnly: true });
  window.ffsRerenderTimeline();
}

function exportCSV(clips) {
  const rows = clips.map(c =>
    `"${c.name}","${c.sequenceName}","${c.trackType}${c.trackIndex}",${c.start.toFixed(2)},${c.duration.toFixed(2)},"${c.effects.join('; ')}",${c.scale},${c.opacity},${c.volume}`
  );
  const csv = "name,sequence,track,start,duration,effects,scale,opacity,volume\n" + rows.join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "universal_search_results.csv";
  a.click();
}

// ===================== VIEW SWITCHING =====================
function switchView(viewName) {
  currentView = viewName;
  document.getElementById('table-view').classList.toggle('hidden', viewName !== 'table');
  document.getElementById('layers-view').classList.toggle('hidden', viewName !== 'layers');
  const analyticsView = document.getElementById('analytics-view');
  if (analyticsView) analyticsView.classList.toggle('hidden', viewName !== 'analytics');
  const scannerView = document.getElementById('scanner-view');
  if (scannerView) scannerView.classList.toggle('hidden', viewName !== 'scanner');

  // Update seg buttons
  document.querySelectorAll('#view-seg button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === viewName);
  });

  if (viewName === 'layers') renderLayerOverview();
  if (viewName === 'analytics') renderAnalyticsDashboard();
  if (viewName === 'scanner') renderScannerDashboard();
}

// ===================== AUTO-SELECT =====================
async function autoSelectMatches(results) {
  const ids = results.map(c => c.id);
  selectedIds = new Set(ids);
  await evalHost("ffs_selectClips", JSON.stringify(ids));
  runSearch(lastQuery, { rerenderOnly: true });
  window.ffsRerenderTimeline();
}

// ===================== LAYER OVERVIEW =====================
async function renderLayerOverview() {
  const layerListEl = document.getElementById("layer-list");
  if (!layerListEl) return;

  const data = await evalHost("ffs_getLayerOverview");
  if (!data || !data.tracks) {
    layerListEl.innerHTML = '<div class="layer-empty">No clips in active sequence.</div>';
    return;
  }
  lastLayerData = data;

  const fxData = await evalHost("ffs_getEffectsList");
  if (fxData && fxData.effects) knownEffects = fxData.effects;

  const currentQuery = document.getElementById("query").value.toLowerCase().trim();
  layerListEl.innerHTML = "";

  data.tracks.forEach(track => {
    const trackGroup = document.createElement("div");
    trackGroup.className = "layer-track-group";

    const trackHeader = document.createElement("div");
    trackHeader.className = "layer-track-header" + (track.type === "A" ? " audio" : "");
    trackHeader.innerHTML = `
      <svg class="layer-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>
      <span class="layer-track-icon ${track.type === 'A' ? 'audio' : 'video'}">
        ${track.type === 'A'
          ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
          : '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
        }
      </span>
      <span class="layer-track-name">${track.name}</span>
      <span class="layer-track-count">${track.clips.length} clip${track.clips.length !== 1 ? 's' : ''}</span>
    `;
    trackHeader.addEventListener("click", () => trackGroup.classList.toggle("collapsed"));
    trackGroup.appendChild(trackHeader);

    const clipsContainer = document.createElement("div");
    clipsContainer.className = "layer-clips";

    track.clips.forEach(clip => {
      const clipRow = document.createElement("div");
      const hasMatchingEffect = currentQuery && clip.effects.some(fx => fx.displayName.toLowerCase().includes(currentQuery));
      const nameMatches = currentQuery && clip.name.toLowerCase().includes(currentQuery);
      const isMatch = hasMatchingEffect || nameMatches;
      const isSelected = selectedIds.has(clip.id);

      clipRow.className = "layer-clip-row" + (isMatch ? " match" : "") + (isSelected ? " selected" : "");

      const mins = Math.floor(clip.start / 60);
      const secs = Math.floor(clip.start % 60);
      const tc = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

      const fxChips = clip.effects.map(fx => {
        const fxMatch = currentQuery && fx.displayName.toLowerCase().includes(currentQuery);
        return `<span class="layer-fx-chip${fxMatch ? ' highlight' : ''}">${escapeHtmlMain(fx.displayName)}</span>`;
      }).join("");

      clipRow.innerHTML = `
        <div class="layer-clip-info">
          <span class="layer-clip-name">${escapeHtmlMain(clip.name)}</span>
          <span class="layer-clip-tc">${tc} · ${clip.duration.toFixed(1)}s</span>
        </div>
        <div class="layer-clip-effects">${fxChips || '<span class="layer-no-fx">No effects</span>'}</div>
      `;

      clipRow.addEventListener("click", (e) => {
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        const snapClip = lastSnapshot.find(c => c.id === clip.id);
        if (snapClip) selectClip(snapClip, additive);
      });
      clipsContainer.appendChild(clipRow);
    });

    trackGroup.appendChild(clipsContainer);
    layerListEl.appendChild(trackGroup);
  });
}

// ===================== ANALYTICS DASHBOARD =====================
async function renderAnalyticsDashboard() {
  const container = document.getElementById("analytics-view");
  if (!container) return;

  container.innerHTML = '<div class="analytics-loading">Analyzing project...</div>';

  const stats = await evalHost("ffs_getProjectStats");
  if (!stats || stats.error) {
    container.innerHTML = '<div class="layer-empty">Could not load project stats.</div>';
    return;
  }

  // Sort effects by usage
  const effectEntries = Object.entries(stats.effectUsage || {}).sort((a, b) => b[1] - a[1]);
  const topEffects = effectEntries.slice(0, 12);

  container.innerHTML = `
    <div class="analytics-grid">
      <div class="analytics-card">
        <div class="analytics-card-value">${stats.sequenceCount}</div>
        <div class="analytics-card-label">Sequences</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-value">${stats.totalVideoClips}</div>
        <div class="analytics-card-label">Video Clips</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-value">${stats.totalAudioClips}</div>
        <div class="analytics-card-label">Audio Clips</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-value">${stats.totalEffects}</div>
        <div class="analytics-card-label">Effects Applied</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-value">${stats.totalMarkers}</div>
        <div class="analytics-card-label">Markers</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-value">${stats.totalProjectItems}</div>
        <div class="analytics-card-label">Project Items</div>
      </div>
      <div class="analytics-card ${stats.offlineCount > 0 ? 'danger' : ''}">
        <div class="analytics-card-value">${stats.offlineCount}</div>
        <div class="analytics-card-label">Offline Media</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-value">${stats.totalBins}</div>
        <div class="analytics-card-label">Bins / Folders</div>
      </div>
    </div>

    <div class="analytics-section">
      <div class="analytics-section-title">Most Used Effects</div>
      <div class="analytics-effects-list">
        ${topEffects.map(([name, count]) => {
          const pct = Math.round((count / Math.max(stats.totalEffects, 1)) * 100);
          return `
            <div class="analytics-effect-row" data-effect="${escapeHtmlMain(name)}">
              <span class="analytics-effect-name">${escapeHtmlMain(name)}</span>
              <div class="analytics-effect-bar"><div class="analytics-effect-fill" style="width:${pct}%"></div></div>
              <span class="analytics-effect-count">${count}</span>
            </div>`;
        }).join("")}
      </div>
    </div>
  `;

  // Click on an effect row to search for it
  container.querySelectorAll(".analytics-effect-row").forEach(row => {
    row.addEventListener("click", () => {
      const fx = row.dataset.effect;
      document.getElementById("query").value = `effect:"${fx}"`;
      switchView("table");
      runSearch(`effect:"${fx}"`);
    });
  });
}

// ===================== PERFORMANCE SCANNER =====================
async function renderScannerDashboard() {
  const container = document.getElementById("scanner-view");
  if (!container) return;

  container.innerHTML = '<div class="analytics-loading">Scanning for bottlenecks...</div>';

  const warpClips = lastSnapshot.filter(c => c.effects.some(e => e.toLowerCase().includes("warp stabilizer")));
  const lumetriClips = lastSnapshot.filter(c => c.effects.some(e => e.toLowerCase().includes("lumetri")));
  const heavyClips = lastSnapshot.filter(c => c.effects.length > 4);
  const missingProxy = lastSnapshot.filter(c => !c.proxy && c.trackType === "V" && !c.nested);
  const offlineClips = lastSnapshot.filter(c => c.offline);

  const totalIssues = warpClips.length + heavyClips.length + offlineClips.length;
  const healthScore = Math.max(0, 100 - warpClips.length * 8 - heavyClips.length * 3 - offlineClips.length * 15);
  const healthColor = healthScore >= 80 ? 'var(--green)' : (healthScore >= 50 ? 'var(--amber)' : 'var(--red)');

  container.innerHTML = `
    <div class="scanner-header">
      <div class="scanner-score" style="color:${healthColor}">
        <span class="scanner-score-num">${healthScore}</span>
        <span class="scanner-score-label">Health Score</span>
      </div>
      <div class="scanner-summary">${totalIssues} issue${totalIssues !== 1 ? 's' : ''} found</div>
    </div>

    <div class="scanner-issues">
      ${warpClips.length > 0 ? `
        <div class="scanner-issue danger" data-query='effect:"Warp Stabilizer"'>
          <div class="scanner-issue-icon">⚠</div>
          <div class="scanner-issue-body">
            <div class="scanner-issue-title">${warpClips.length} Warp Stabilizer clip${warpClips.length !== 1 ? 's' : ''}</div>
            <div class="scanner-issue-desc">GPU-intensive effect. Consider pre-rendering or using proxy media.</div>
          </div>
          <div class="scanner-issue-badge high">High</div>
        </div>` : ''}

      ${offlineClips.length > 0 ? `
        <div class="scanner-issue danger" data-query="offline:true">
          <div class="scanner-issue-icon">🔴</div>
          <div class="scanner-issue-body">
            <div class="scanner-issue-title">${offlineClips.length} Offline media file${offlineClips.length !== 1 ? 's' : ''}</div>
            <div class="scanner-issue-desc">Media is missing or disconnected. Relink to restore.</div>
          </div>
          <div class="scanner-issue-badge high">Critical</div>
        </div>` : ''}

      ${heavyClips.length > 0 ? `
        <div class="scanner-issue warn" data-query="text:heavy">
          <div class="scanner-issue-icon">⚡</div>
          <div class="scanner-issue-body">
            <div class="scanner-issue-title">${heavyClips.length} clip${heavyClips.length !== 1 ? 's' : ''} with 5+ effects stacked</div>
            <div class="scanner-issue-desc">Heavy effect stacking can slow playback. Consider nesting or pre-rendering.</div>
          </div>
          <div class="scanner-issue-badge med">Medium</div>
        </div>` : ''}

      ${lumetriClips.length > 0 ? `
        <div class="scanner-issue info" data-query='effect:"Lumetri Color"'>
          <div class="scanner-issue-icon">🎨</div>
          <div class="scanner-issue-body">
            <div class="scanner-issue-title">${lumetriClips.length} Lumetri Color instance${lumetriClips.length !== 1 ? 's' : ''}</div>
            <div class="scanner-issue-desc">Color grading is applied. Moderate GPU usage per instance.</div>
          </div>
          <div class="scanner-issue-badge low">Info</div>
        </div>` : ''}

      ${missingProxy.length > 0 ? `
        <div class="scanner-issue info" data-query="proxy:false">
          <div class="scanner-issue-icon">📹</div>
          <div class="scanner-issue-body">
            <div class="scanner-issue-title">${missingProxy.length} video clip${missingProxy.length !== 1 ? 's' : ''} without proxies</div>
            <div class="scanner-issue-desc">Creating proxies can improve timeline playback performance.</div>
          </div>
          <div class="scanner-issue-badge low">Suggestion</div>
        </div>` : ''}

      ${totalIssues === 0 ? `
        <div class="scanner-issue ok">
          <div class="scanner-issue-icon">✅</div>
          <div class="scanner-issue-body">
            <div class="scanner-issue-title">No performance issues detected</div>
            <div class="scanner-issue-desc">Your project timeline is optimized for smooth playback.</div>
          </div>
        </div>` : ''}
    </div>
  `;

  // Click issue to search for it
  container.querySelectorAll(".scanner-issue[data-query]").forEach(row => {
    row.addEventListener("click", () => {
      document.getElementById("query").value = row.dataset.query;
      switchView("table");
      runSearch(row.dataset.query);
    });
  });
}

// ===================== SAVED SEARCHES =====================
function renderSavedSearches() {
  const cnt = document.querySelector('.saved-searches-cnt');
  if (cnt) cnt.textContent = savedSearches.length;
}

// ===================== UTILITIES =====================
function escapeHtmlMain(s) {
  return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

window.ffsOnTimelineClipClick = (id, additive) => {
  const clip = lastSnapshot.find(c => c.id === id);
  if (clip) selectClip(clip, additive);
};

window.ffsRerenderTimeline = () => {
  renderTimeline(lastSnapshot, activeSequenceName, matchIds, selectedIds, playheadSeconds);
};

// ===================== EVENT BINDINGS =====================

// Keyboard: Ctrl+P command palette
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "p") {
    e.preventDefault();
    showCommandPalette();
  }
  if (e.key === "Escape") hideCommandPalette();
});

// Command palette input
document.getElementById("cmd-input").addEventListener("input", (e) => {
  selectedCmdIndex = 0;
  renderCommands(e.target.value);
});

document.getElementById("cmd-input").addEventListener("keydown", (e) => {
  const items = document.getElementById("cmd-list").querySelectorAll(".cmd-item");
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedCmdIndex = (selectedCmdIndex + 1) % items.length;
    renderCommands(document.getElementById("cmd-input").value);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedCmdIndex = (selectedCmdIndex - 1 + items.length) % items.length;
    renderCommands(document.getElementById("cmd-input").value);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const activeItem = items[selectedCmdIndex];
    if (activeItem) {
      const text = activeItem.firstChild.textContent.trim();
      const cmd = COMMANDS.find(c => c.name === text);
      if (cmd) executeCommand(cmd);
    }
  }
});

// Sidebar click triggers quick filtering
document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", () => {
    const text = item.textContent.trim();
    const queryInput = document.getElementById("query");

    // Activate the nav item
    document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
    item.classList.add("active");

    if (text.startsWith("All Results")) {
      queryInput.value = "all:true";
    } else if (text.startsWith("Video Clips")) {
      queryInput.value = "mediatype:video";
    } else if (text.startsWith("Audio Clips")) {
      queryInput.value = "mediatype:audio";
    } else if (text.startsWith("Sequences")) {
      queryInput.value = "mediatype:sequence";
    } else if (text.startsWith("Nested")) {
      queryInput.value = "nested:true";
    } else if (text.startsWith("Adjustment")) {
      queryInput.value = "adjustment:true";
    } else if (text.startsWith("Essential Graphics")) {
      queryInput.value = "graphic:true";
    } else if (text.startsWith("Captions")) {
      queryInput.value = "caption:true";
    } else if (text.startsWith("Titles")) {
      queryInput.value = "title:true";
    } else if (text.startsWith("Text Layers")) {
      queryInput.value = "textlayer:true";
    } else if (text.startsWith("Markers")) {
      queryInput.value = "hasmarkers:true";
    } else if (text.startsWith("Offline Media")) {
      queryInput.value = "offline:true";
    } else if (text.startsWith("Proxies")) {
      queryInput.value = "proxy:true";
    } else if (text.startsWith("Unused Media")) {
      queryInput.value = "unused:true";
    } else if (text.startsWith("Markers")) {
      queryInput.value = "marker:*";
    } else if (text.startsWith("Project Analytics")) {
      switchView("analytics");
      return;
    } else if (text.startsWith("Performance Scanner")) {
      switchView("scanner");
      return;
    } else if (text.startsWith("Timeline Health")) {
      switchView("scanner");
      return;
    } else if (text.startsWith("Saved Queries")) {
      // Show saved searches as chips
      if (savedSearches.length > 0) {
        queryInput.value = savedSearches[savedSearches.length - 1];
      }
    } else if (text.startsWith("Settings")) {
      showCommandPalette();
      return;
    } else {
      // Generic: try to use the sidebar text as a search
      return;
    }

    switchView("table");
    runSearch(queryInput.value);
  });
});

// AI Toggle click
document.querySelector(".ai-toggle").addEventListener("click", () => {
  aiSearchEnabled = !aiSearchEnabled;
  document.querySelector(".ai-toggle").classList.toggle("active", aiSearchEnabled);
  runSearch(document.getElementById("query").value);
});

// Auto-select toggle
document.getElementById("auto-select-chk").addEventListener("change", (e) => {
  autoSelectEnabled = e.target.checked;
});

// Search input
document.getElementById("query").addEventListener("input", (e) => runSearch(e.target.value));

// View switching via seg buttons
document.querySelectorAll('#view-seg button').forEach(btn => {
  btn.addEventListener('click', () => {
    switchView(btn.dataset.view || 'table');
  });
});

// Run button
const btnRun = document.querySelector(".btn-ai-run");
if (btnRun) {
  btnRun.addEventListener("click", () => {
    runSearch(document.getElementById("query").value);
  });
}

// Batch actions panel
document.getElementById("batch-actions").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const action = btn.dataset.action;
  if (!action) return;
  const currentMatches = lastSnapshot.filter(c => matchIds.has(c.id));

  if (action === "select-all") {
    selectedIds = new Set(currentMatches.map(c => c.id));
    await evalHost("ffs_selectClips", JSON.stringify(Array.from(selectedIds)));
  } else if (action === "reveal-first") {
    if (currentMatches[0]) {
      selectedIds = new Set([currentMatches[0].id]);
      await evalHost("ffs_selectClips", JSON.stringify(Array.from(selectedIds)));
    }
  } else if (action === "select-sequence") {
    const inSeq = currentMatches.filter(c => c.sequenceName === activeSequenceName);
    selectedIds = new Set(inSeq.map(c => c.id));
    await evalHost("ffs_selectClips", JSON.stringify(Array.from(selectedIds)));
  } else if (action === "select-project") {
    selectedIds = new Set(currentMatches.map(c => c.id));
    await evalHost("ffs_selectClips", JSON.stringify(Array.from(selectedIds)));
  } else if (action === "export") {
    exportCSV(currentMatches);
  }

  runSearch(lastQuery, { rerenderOnly: true });
  window.ffsRerenderTimeline();
});

// Initial render of saved searches badge
renderSavedSearches();

// Start polling
pollProject();
setInterval(pollProject, POLL_MS);
