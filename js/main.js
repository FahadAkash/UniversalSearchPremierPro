// Universal Search — main panel controller
// Polls the ExtendScript host for the current project state.

const csInterface = new CSInterface();
const POLL_MS = 2000;

let lastSnapshot = [];
let lastProjectAssets = [];
let lastQuery = "";
let matchIds = new Set();
let selectedIds = new Set();
let activeSequenceName = null;
let playheadSeconds = 0;
let aiSearchEnabled = false;
let autoSelectEnabled = false;
let searchDebounceTimer = null;
let lastLayerData = null;
let knownEffects = [];
let currentView = 'table';
let projectStats = null;
let projectName = "Loading...";
let savedSearches = [];
let lastSelectedNodeId = null;

// Load saved searches from localStorage
try { savedSearches = JSON.parse(localStorage.getItem("ffs_savedSearches") || "[]"); } catch(e) {}

// Load cached project data from localStorage to show immediately
try { 
  lastSnapshot = JSON.parse(localStorage.getItem("ffs_cachedSnapshot") || "[]"); 
  lastProjectAssets = JSON.parse(localStorage.getItem("ffs_cachedAssets") || "[]");
} catch(e) {}

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
let pollQueued = false;
let lastInteractionTime = 0;

// Track user interactions to pause polling, keeping ExtendScript engine free for instant selection
document.addEventListener("mousemove", () => { lastInteractionTime = Date.now(); });
document.addEventListener("keydown", () => { lastInteractionTime = Date.now(); });
document.addEventListener("click", () => { lastInteractionTime = Date.now(); });

async function pollProject(force = false) {
  if (isPolling) {
    if (force) pollQueued = true;
    return;
  }
  
  // Show scan bar on forced scans
  if (force) {
    const scanBar = document.getElementById("scan-bar");
    if (scanBar) scanBar.classList.remove("hidden");
  }
  // If the user has interacted within the last 1500ms, skip polling
  if (!force && Date.now() - lastInteractionTime < 1500) return;
  
  isPolling = true;
  try {
    const t0 = performance.now();
    // Fetch instant state first
    const stateJson = await evalHost("ffs_getActiveState");
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
      
      // Auto-Reveal Bin Selection logic
      const chkAutoReveal = document.getElementById("chk-auto-reveal");
      if (chkAutoReveal && chkAutoReveal.checked && state.selectedNodeId) {
        if (state.selectedNodeId !== lastSelectedNodeId) {
          lastSelectedNodeId = state.selectedNodeId;
          evalHost("ffs_revealProjectItemInTimeline", state.selectedNodeId);
        }
      } else if (!state.selectedNodeId) {
        lastSelectedNodeId = null;
      }
    } else {
      indicator.innerHTML = '<span class="dot" style="background:var(--red); box-shadow:none;"></span> Disconnected';
      indicator.style.opacity = "0.7";
    }

    // Now do the heavy snapshot fetch
    const snapshotRes = await evalHost("ffs_getProjectSnapshot");
    const searchTime = (performance.now() - t0).toFixed(0);

    // Update search timing
    const speedEl = document.querySelector(".stat-pill.speed b");
    if (speedEl) speedEl.textContent = searchTime + "ms";

    if (typeof snapshotRes === 'object' && snapshotRes !== null) {
      lastSnapshot = snapshotRes.sequenceClips || [];
      lastProjectAssets = snapshotRes.projectAssets || [];
      // Cache data for instant loading next time
      try {
        localStorage.setItem("ffs_cachedSnapshot", JSON.stringify(lastSnapshot));
        localStorage.setItem("ffs_cachedAssets", JSON.stringify(lastProjectAssets));
      } catch(e) {}
    } else {
      lastSnapshot = [];
      lastProjectAssets = [];
    }
    
    // Hide scan bar if it's visible
    const scanBar = document.getElementById("scan-bar");
    if (scanBar && !scanBar.classList.contains("hidden")) {
      scanBar.classList.add("hidden");
    }

    runSearch(lastQuery, { rerenderOnly: true });
    window.ffsRerenderTimeline();
    updateAnalytics();
    updatePerformanceScanner();
    updateSuggestions();

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
    if (pollQueued) {
      pollQueued = false;
      pollProject(true);
    }
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
  
  const isAssetQuery = searchVal.includes("asset:");
  const searchTarget = isAssetQuery ? lastProjectAssets : lastSnapshot;
  const { results, unsupported } = runQuery(searchTarget, searchVal);
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
    item.dataset.clipId = clip.id;

    if (isAssetQuery) {
      // Render Project Asset Row
      if (selectedIds.has(clip.id)) {
        item.className = "selected match-glow";
      } else {
        item.className = matchIds.has(clip.id) ? "match-glow" : "";
      }
      const isBin = clip.type === "Bin";
      const icon = isBin 
        ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M7 7V5a2 2 0 012-2h6a2 2 0 012 2v2"/></svg>`
        : `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M13 2v7h7"/></svg>`;
      
      const usageTag = clip.usage === 0 && !isBin ? `<span class="fx-chip" style="color:var(--amber)">Unused</span>` : "";
      const offlineTag = clip.isOffline ? `<span class="tag offline">● Offline</span>` : "";
      const proxyTag = clip.hasProxy ? `<span class="tag proxy">◐ Proxy</span>` : "";
      
      item.innerHTML = `
        <td><div class="cell-name"><span class="type-ico">${icon}</span>${escapeHtmlMain(clip.name)}</div></td>
        <td>Project Bin</td>
        <td class="mono">${clip.type}</td>
        <td colspan="5" class="mono" style="opacity:0.5; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${clip.mediaPath || ""}">${clip.mediaPath || "—"}</td>
        <td>${usageTag}</td>
        <td>${offlineTag} ${proxyTag}</td>
        <td colspan="2"></td>
      `;
      
      item.addEventListener("click", (e) => {
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
          selectedIds.clear();
        }
        selectedIds.add(clip.id);
        
        // Update local UI immediately so it feels instant
        updateInspector(clip);
        if (window.fastUpdateHighlight) {
          window.fastUpdateHighlight();
          window.pulseTimelineClip(clip.id);
        } else {
          runSearch(lastQuery, { rerenderOnly: true });
          window.ffsRerenderTimeline();
        }
      });
      
    } else {
      // Render Timeline Clip Row
      if (selectedIds.has(clip.id)) {
        item.className = "selected match-glow";
      } else {
        item.className = matchIds.has(clip.id) ? "match-glow" : "";
      }
      const fxCount = clip.effects ? clip.effects.length : 0;
      const hasWarp = clip.effects ? clip.effects.some(e => e.toLowerCase().includes("warp stabilizer")) : false;
      const costClass = hasWarp ? "high" : (fxCount > 3 ? "high" : (fxCount > 1 ? "med" : "low"));
      const costLabel = costClass === "high" ? "High" : (costClass === "med" ? "Med" : "Low");
      const statusText = clip.offline ? `<span class="tag offline">● Offline</span>` : (clip.proxy ? `<span class="tag proxy">◐ Proxy</span>` : `<span class="tag online">● Online</span>`);
      const labelColor = clip.colorLabel ? `style="background:${clip.colorLabel}"` : '';

      // Timecode formatting
      const tcMins = Math.floor(clip.start / 60);
      const tcSecs = Math.floor(clip.start % 60);
      const tcFrames = Math.round((clip.start % 1) * 24);
      const timecode = `${tcMins.toString().padStart(2,'0')}:${tcSecs.toString().padStart(2,'0')}:${tcFrames.toString().padStart(2,'0')}`;

      const typeClass = clip.trackType === "S" ? "adj" : (clip.trackType === "A" ? "audio" : ((clip.nested || clip.adjustment) ? "adj" : "video"));
      const typeIco = clip.trackType === "S"
        ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M7 6v12M17 6v12"/></svg>`
        : (clip.trackType === "A"
          ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`
          : `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`);

      const fxChips = clip.effects ? clip.effects.map(fx => `<span class="fx-chip">${fx}</span>`).join("") : "";

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
      item.addEventListener("mouseenter", () => { 
        hoveredClipId = clip.id; 
        if(window.fastUpdateHighlight) window.fastUpdateHighlight(); else window.ffsRerenderTimeline(); 
      });
      item.addEventListener("mouseleave", () => { 
        hoveredClipId = null; 
        if(window.fastUpdateHighlight) window.fastUpdateHighlight(); else window.ffsRerenderTimeline(); 
      });
    }

    resultsEl.appendChild(item);
  });
}

function selectClip(clip, additive) {
  if (!additive) selectedIds = new Set();
  selectedIds.add(clip.id);
  
  // Update local UI immediately so it feels instant
  updateInspector(clip);
  syncSelectionToPremiere();
  
  if (window.fastUpdateHighlight) {
    window.fastUpdateHighlight();
    window.pulseTimelineClip(clip.id);
  } else {
    runSearch(lastQuery, { rerenderOnly: true });
    window.ffsRerenderTimeline();
  }
}

function syncSelectionToPremiere() {
  const ids = Array.from(selectedIds);
  const projIds = ids.filter(id => id.startsWith("proj_"));
  const clipIds = ids.filter(id => !id.startsWith("proj_"));

  if (projIds.length) {
    evalHost("ffs_selectProjectItems", JSON.stringify(projIds.map(id => id.replace("proj_", ""))));
  }
  if (clipIds.length) {
    evalHost("ffs_selectClips", JSON.stringify(clipIds));
  }
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
        effectsHtml += `<div class="prop-row" style="margin-top:8px"><span class="k">● <b style="color:var(--text-1)">${escapeHtmlMain(fx)}</b></span><span class="v" style="color:${isHeavy ? 'var(--red)' : 'var(--text-2)'}">${isHeavy ? 'Heavy' : 'Light'}</span></div>`;
      });
      // Also list effect parameters
      if (clip.effectParams) {
         for (let key in clip.effectParams) {
           let val = clip.effectParams[key];
           if (typeof val === "boolean") val = val ? "On" : "Off";
           effectsHtml += `<div class="prop-row"><span class="k" style="padding-left:16px; font-size:11px; color:var(--text-3)">${escapeHtmlMain(key)}</span><span class="v" style="font-size:11px">${escapeHtmlMain(String(val))}</span></div>`;
         }
      }
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

  // Update Metadata section
  const metaSec = document.getElementById("insp-metadata");
  if (metaSec) {
    metaSec.innerHTML = `
      <div class="insp-section-title">Metadata</div>
      <div class="prop-row"><span class="k">Media Path</span><span class="v" style="word-break: break-all; text-align:right;">${escapeHtmlMain(clip.mediaPath || '—')}</span></div>
      <div class="prop-row"><span class="k">Camera</span><span class="v">${escapeHtmlMain(clip.camera || '—')}</span></div>
      <div class="prop-row"><span class="k">Resolution</span><span class="v">${escapeHtmlMain(clip.resolution || '—')}</span></div>
      <div class="prop-row"><span class="k">Frame Rate</span><span class="v">${clip.fps ? clip.fps + ' fps' : '—'}</span></div>
      <div class="prop-row"><span class="k">Codec</span><span class="v">${escapeHtmlMain(clip.codec || '—')}</span></div>
      <div class="prop-row"><span class="k">Color Label</span><span class="v">${escapeHtmlMain(clip.colorLabel || '—')}</span></div>
      <div class="prop-row"><span class="k">Offline</span><span class="v">${clip.offline ? 'Yes' : 'No'}</span></div>
      <div class="prop-row"><span class="k">Proxy</span><span class="v">${clip.proxy ? 'Attached' : 'None'}</span></div>
    `;
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
    transitions: lastSnapshot.filter(c => c.mediaType === "Transition").length,
    animPresets: lastSnapshot.filter(c => c.keyframeCount > 0).length,
    motionModified: lastSnapshot.filter(c => c.scale !== 100 || c.rotation !== 0 || c.position !== "960, 540").length,
    totalKeyframes: lastSnapshot.reduce((acc, c) => acc + (c.keyframeCount || 0), 0),
    audioEffects: lastSnapshot.filter(c => c.trackType === "A" && c.effects && c.effects.length > 0).length,
    lumetri: lastSnapshot.filter(c => c.hasLumetri).length,
    colors: lastSnapshot.filter(c => c.isGraphic).length,
    fonts: lastSnapshot.filter(c => c.isText || c.isTitle).length,
    effectsCount: lastSnapshot.reduce((acc, c) => acc + (c.effects ? c.effects.length : 0), 0),
    offlineCount: lastSnapshot.filter(c => c.offline).length,
    proxyCount: lastSnapshot.filter(c => c.proxy).length,
    noProxyCount: lastSnapshot.filter(c => !c.proxy && c.trackType === "V" && !c.nested).length,
    
    // Project Asset Stats
    assetFiles: lastProjectAssets.filter(p => p.type === "File").length,
    assetBins: lastProjectAssets.filter(p => p.type === "Bin").length,
    assetOffline: lastProjectAssets.filter(p => p.isOffline).length,
    assetUnused: lastProjectAssets.filter(p => p.type === "File" && p.usage === 0).length,
    assetProxies: lastProjectAssets.filter(p => p.hasProxy).length,
    assetDuplicates: 0 // Will compute below
  };

  // Compute duplicate assets
  const pathCounts = {};
  for (let i = 0; i < lastProjectAssets.length; i++) {
    const p = lastProjectAssets[i].mediaPath;
    if (p) {
      pathCounts[p] = (pathCounts[p] || 0) + 1;
    }
  }
  stats.assetDuplicates = Object.values(pathCounts).filter(count => count > 1).reduce((a, b) => a + b, 0);

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
    else if (text.startsWith("Transitions")) cnt.textContent = stats.transitions;
    else if (text.startsWith("Animation Presets")) cnt.textContent = stats.animPresets;
    else if (text.startsWith("Motion Properties")) cnt.textContent = stats.motionModified;
    else if (text.startsWith("Keyframes")) cnt.textContent = stats.totalKeyframes;
    else if (text.startsWith("Audio Effects")) cnt.textContent = stats.audioEffects;
    else if (text.startsWith("Lumetri")) cnt.textContent = stats.lumetri;
    else if (text.startsWith("Color Labels")) {
      var allLabels = [];
      for (var i = 0; i < lastSnapshot.length; i++) {
        var lbl = lastSnapshot[i].colorLabel;
        if (lbl && lbl !== "0" && allLabels.indexOf(lbl) === -1) {
          allLabels.push(lbl);
        }
      }
      cnt.textContent = allLabels.length;
    }
    else if (text.startsWith("Fonts")) cnt.textContent = stats.fonts;
    else if (text.startsWith("Colors")) cnt.textContent = stats.colors;
    else if (text.startsWith("Project Files")) cnt.textContent = stats.assetFiles;
    else if (text.startsWith("Folders") || text.startsWith("Bins")) cnt.textContent = stats.assetBins;
    else if (text.startsWith("Unused Media")) cnt.textContent = stats.assetUnused;
    else if (text.startsWith("Duplicate Assets")) cnt.textContent = stats.assetDuplicates;
    else if (text.startsWith("Missing Fonts")) cnt.textContent = 0; // Hardcoded to 0 for now as per plan
    
    // Handle Offline/Proxies selectively if they are in the Assets group
    else if (text.startsWith("Offline Media")) {
      cnt.textContent = stats.assetOffline;
    }
    else if (text.startsWith("Offline")) cnt.textContent = stats.offlineCount;
    else if (text.startsWith("Proxies") && item.closest('.sec-body')) {
      // Check if it's the proxy under Assets or under timeline
      if (item.parentNode.previousElementSibling && item.parentNode.previousElementSibling.textContent.includes('ASSETS')) {
        cnt.textContent = stats.assetProxies;
      } else {
        cnt.textContent = stats.proxyCount;
      }
    }
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
    const aiEl = document.querySelector(".ai-toggle");
    if (aiEl) aiEl.classList.toggle("active", aiSearchEnabled);
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

  // If we have no snapshot data yet, try a fresh poll first
  if (lastSnapshot.length === 0 && lastProjectAssets.length === 0) {
    container.innerHTML = '<div class="analytics-loading">Analyzing project...</div>';
    await pollProject(true);
  }

  // Compute stats from local data — no extra ExtendScript call needed
  const seqNames = new Set();
  let totalVideoClips = 0;
  let totalAudioClips = 0;
  let totalEffects = 0;
  let totalMarkers = 0;
  let offlineCount = 0;
  const effectUsage = {};

  for (let i = 0; i < lastSnapshot.length; i++) {
    const c = lastSnapshot[i];
    if (c.sequenceName) seqNames.add(c.sequenceName);
    if (c.trackType === "V") totalVideoClips++;
    else if (c.trackType === "A") totalAudioClips++;
    if (c.offline) offlineCount++;
    if (c.markerCount) totalMarkers += c.markerCount;
    if (c.effects && c.effects.length > 0) {
      for (let j = 0; j < c.effects.length; j++) {
        const fx = c.effects[j];
        totalEffects++;
        effectUsage[fx] = (effectUsage[fx] || 0) + 1;
      }
    }
  }

  // Project-level stats from lastProjectAssets
  const totalProjectItems = lastProjectAssets.length;
  let totalBins = 0;
  let projectOffline = 0;
  for (let i = 0; i < lastProjectAssets.length; i++) {
    if (lastProjectAssets[i].type === "Bin") totalBins++;
    if (lastProjectAssets[i].isOffline) projectOffline++;
  }

  const sequenceCount = seqNames.size;
  const finalOffline = offlineCount + projectOffline;

  // Sort effects by usage
  const effectEntries = Object.entries(effectUsage).sort((a, b) => b[1] - a[1]);
  const topEffects = effectEntries.slice(0, 12);

  container.innerHTML = `
    <div class="analytics-grid">
      <div class="analytics-card">
        <div class="analytics-card-value">${sequenceCount}</div>
        <div class="analytics-card-label">Sequences</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-value">${totalVideoClips}</div>
        <div class="analytics-card-label">Video Clips</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-value">${totalAudioClips}</div>
        <div class="analytics-card-label">Audio Clips</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-value">${totalEffects}</div>
        <div class="analytics-card-label">Effects Applied</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-value">${totalMarkers}</div>
        <div class="analytics-card-label">Markers</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-value">${totalProjectItems}</div>
        <div class="analytics-card-label">Project Items</div>
      </div>
      <div class="analytics-card ${finalOffline > 0 ? 'danger' : ''}">
        <div class="analytics-card-value">${finalOffline}</div>
        <div class="analytics-card-label">Offline Media</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-value">${totalBins}</div>
        <div class="analytics-card-label">Bins / Folders</div>
      </div>
    </div>

    <div class="analytics-section">
      <div class="analytics-section-title">Most Used Effects</div>
      <div class="analytics-effects-list">
        ${topEffects.length === 0 ? '<div style="color:var(--text-3); padding: 8px 0;">No effects found in project.</div>' : topEffects.map(([name, count]) => {
          const pct = Math.round((count / Math.max(totalEffects, 1)) * 100);
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

let allSuggestions = [];
let effectToParams = new Map(); // Maps effectDisplayName -> Set of parameter names

function updateSuggestions() {
  const coreOptions = [
    { type: "core", query: "effect:", name: "Effect Name", icon: "✨" },
    { type: "core", query: "duration:", name: "Duration", icon: "⏱" },
    { type: "core", query: "sequence:", name: "Sequence Name", icon: "🎞" },
    { type: "core", query: "offline:true", name: "Offline Media", icon: "⚠️" },
    { type: "core", query: "volume:", name: "Volume (dB)", icon: "🔊" },
    { type: "core", query: "opacity:", name: "Opacity (%)", icon: "👁" },
    { type: "core", query: "scale:", name: "Scale (%)", icon: "📏" },
    { type: "core", query: "rotation:", name: "Rotation (°)", icon: "🔄" },
    { type: "core", query: "hasmarkers:true", name: "Has Markers", icon: "📍" },
    { type: "core", query: "has_effects:true", name: "Has Effects", icon: "🎨" }
  ];
  
  const paramMap = new Map();
  const effectMap = new Map();
  effectToParams = new Map();

  // Dynamically extract unique effect parameters across all clips
  lastSnapshot.forEach(c => {
    if (c.effectParamGroups && c.effectParamNames) {
      for (const effectName in c.effectParamGroups) {
        if (!effectToParams.has(effectName)) {
          effectToParams.set(effectName, new Set());
        }
        const paramSet = effectToParams.get(effectName);
        const keys = c.effectParamGroups[effectName];
        keys.forEach(k => {
          const originalName = c.effectParamNames[k];
          if (originalName) {
            paramSet.add(originalName);
            paramMap.set(originalName, k);
          }
        });
      }
    } else if (c.effectParamNames) {
      // Fallback if groups are missing
      for (const k in c.effectParamNames) {
        paramMap.set(c.effectParamNames[k], k);
      }
    }
    if (c.effects) {
      c.effects.forEach(fx => effectMap.set(fx, true));
    }
  });

  const paramOptions = Array.from(paramMap.entries()).map(([originalName, squashed]) => ({
    type: "param",
    query: originalName.toLowerCase() + ":",
    name: originalName,
    icon: "⚙️"
  }));
  
  // Pre-seed the system with common built-in Premiere Pro effects
  const COMMON_EFFECTS = [
    "Lumetri Color", "Transform", "Crop", "Gaussian Blur", "Warp Stabilizer",
    "Ultra Key", "ProcAmp", "Levels", "Color Key", "Basic 3D", "Drop Shadow",
    "Directional Blur", "Noise", "Mosaic", "Luma Key", "Track Matte Key",
    "Timecode", "Tint", "Leave Color", "Extract", "Find Edges", "Black & White",
    "Color Balance (RGB)", "Video Limiter", "Morph Cut", "Cross Dissolve",
    "Dip to Black", "Dip to White", "Film Dissolve", "Parametric Equalizer"
  ];
  
  COMMON_EFFECTS.forEach(fx => {
    if (!effectMap.has(fx)) effectMap.set(fx, true);
  });

  const effectOptions = Array.from(effectMap.keys()).map(fx => ({
    type: "effect",
    query: 'effect:"' + fx + '"',
    name: fx,
    icon: "✨"
  }));

  allSuggestions = [...coreOptions, ...paramOptions, ...effectOptions];
  
  const qInput = document.getElementById("query");
  if (document.activeElement === qInput) {
    renderCustomSuggestions(qInput.value);
  }
}

function renderCustomSuggestions(filterText = "") {
  const box = document.getElementById("suggestions-box");
  if (!box) return;
  
  const lowerFilter = filterText.toLowerCase().trim();

  // Find active effects in the current search chips
  let activeEffects = [];
  activeQueries.forEach(q => {
    const m = q.match(/effect:"([^"]+)"/i);
    if (m) activeEffects.push(m[1]);
  });

  // Also check if they are currently typing an effect query in the search field
  const typingEffectMatch = filterText.match(/effect:"([^"]*)"?$/i);
  if (typingEffectMatch && typingEffectMatch[1]) {
    activeEffects.push(typingEffectMatch[1]);
  }

  let contextualSuggestions = [];

  // Extract parameters for active/typed effects
  if (activeEffects.length > 0) {
    activeEffects.forEach(activeFx => {
      for (const [fxName, paramSet] of effectToParams.entries()) {
        if (fxName.toLowerCase().indexOf(activeFx.toLowerCase()) !== -1) {
          paramSet.forEach(paramName => {
            contextualSuggestions.push({
              type: "context-param",
              query: paramName.toLowerCase().replace(/\s+/g, "") + ":",
              name: `${paramName} (${fxName})`,
              icon: "⚙️"
            });
          });
        }
      }
    });
  }

  let candidates = [];
  if (contextualSuggestions.length > 0) {
    if (lowerFilter === "") {
      candidates = contextualSuggestions;
    } else {
      candidates = contextualSuggestions.filter(s =>
        s.name.toLowerCase().includes(lowerFilter) ||
        s.query.toLowerCase().includes(lowerFilter)
      );
    }
  }

  // Fallback to general suggestions
  if (candidates.length < 15) {
    const generalFiltered = allSuggestions.filter(s => {
      // Avoid duplicate parameter suggestions if they are already in the contextual list
      if (s.type === "param" && contextualSuggestions.some(cs => cs.query === s.query)) {
        return false;
      }
      if (lowerFilter === "") return s.type === "core" || s.type === "effect";
      return s.name.toLowerCase().includes(lowerFilter) || s.query.toLowerCase().includes(lowerFilter);
    });

    candidates = [...candidates, ...generalFiltered];
  }

  // Remove duplicates based on query string
  const seenQueries = new Set();
  candidates = candidates.filter(s => {
    if (seenQueries.has(s.query)) return false;
    seenQueries.add(s.query);
    return true;
  });

  const filtered = candidates.slice(0, 50);
  
  if (filtered.length === 0) {
    box.classList.add("hidden");
    return;
  }
  
  box.innerHTML = filtered.map(s => `
    <div class="sugg-item" data-query="${escapeHtmlMain(s.query)}">
      <span class="sugg-icon">${s.icon}</span>
      <span class="sugg-match">${escapeHtmlMain(s.name)}</span>
      <span style="opacity: 0.5; margin-left: auto; font-family: var(--font-mono); font-size: 10px;">${escapeHtmlMain(s.query)}</span>
    </div>
  `).join("");
  
  box.classList.remove("hidden");
  
  box.querySelectorAll(".sugg-item").forEach(el => {
    el.addEventListener("click", () => {
      const q = el.dataset.query;
      const qInput = document.getElementById("query");
      if (q.endsWith(":")) {
        // If it's a parameter template (e.g. lowshelffrequency:), populate input and focus to let them complete it (e.g. < 0.6)
        qInput.value = q;
        qInput.focus();
        // Hide suggestions so they can see the input field clearly
        box.classList.add("hidden");
      } else {
        // If it's a complete query (e.g. effect:"Drop Shadow"), add it as a chip immediately
        activeQueries.push(q);
        qInput.value = "";
        box.classList.add("hidden");
        renderActiveChips();
        document.querySelector(".btn-ai-run").click();
      }
    });
  });
}

// Hook up input events
document.addEventListener("DOMContentLoaded", () => {
  const qInput = document.getElementById("query");
  if (qInput) {
    qInput.addEventListener("input", (e) => {
      renderCustomSuggestions(e.target.value);
    });
    qInput.addEventListener("focus", (e) => {
      pollProject(true); // Force an instant poll to get newly added effects
      renderCustomSuggestions(e.target.value);
    });
    qInput.addEventListener("click", (e) => {
      renderCustomSuggestions(e.target.value);
    });
    qInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        document.getElementById("suggestions-box").classList.add("hidden");
      }
    });
    // Hide when clicking outside
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".searchband") && !e.target.closest("#suggestions-box")) {
        document.getElementById("suggestions-box").classList.add("hidden");
      }
    });
  }
});

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
      if (item.parentNode.previousElementSibling && item.parentNode.previousElementSibling.textContent.includes('ASSETS')) {
        queryInput.value = "asset:offline";
      } else {
        queryInput.value = "offline:true";
      }
    } else if (text.startsWith("Proxies")) {
      if (item.parentNode.previousElementSibling && item.parentNode.previousElementSibling.textContent.includes('ASSETS')) {
        queryInput.value = "asset:proxy";
      } else {
        queryInput.value = "proxy:true";
      }
    } else if (text.startsWith("Unused Media")) {
      queryInput.value = "asset:unused";
    } else if (text.startsWith("Project Files")) {
      queryInput.value = "asset:file";
    } else if (text.startsWith("Folders") || text.startsWith("Bins")) {
      queryInput.value = "asset:bin";
    } else if (text.startsWith("Duplicate Assets")) {
      queryInput.value = "asset:duplicate";
    } else if (text.startsWith("Missing Fonts")) {
      queryInput.value = "asset:missingfont";
    } else if (text.startsWith("Markers")) {
      queryInput.value = "hasmarkers:true";
    } else if (text.startsWith("Effect Presets")) {
      queryInput.value = "has_effects:true";
    } else if (text.startsWith("Transitions")) {
      queryInput.value = "mediatype:transition";
    } else if (text.startsWith("Animation Presets")) {
      queryInput.value = "animpresets:true";
    } else if (text.startsWith("Motion Properties")) {
      queryInput.value = "motionmodified:true";
    } else if (text.startsWith("Keyframes")) {
      queryInput.value = "haskeyframes:true";
    } else if (text.startsWith("Audio Effects")) {
      queryInput.value = "audioeffects:true";
    } else if (text.startsWith("Lumetri")) {
      queryInput.value = "lumetri:true";
    } else if (text.startsWith("Color Labels")) {
      queryInput.value = "hascolorlabel:true";
    } else if (text.startsWith("Fonts")) {
      queryInput.value = "hasfonts:true";
    } else if (text.startsWith("Colors")) {
      queryInput.value = "graphic:true";
    } else if (text.startsWith("Camera Information")) {
      queryInput.value = "hascamera:true";
    } else if (text.startsWith("Resolution")) {
      queryInput.value = "hasresolution:true";
    } else if (text.startsWith("Frame Rate")) {
      queryInput.value = "hasfps:true";
    } else if (text.startsWith("Codecs")) {
      queryInput.value = "hascodec:true";
    } else if (text.startsWith("Aspect Ratio")) {
      queryInput.value = "aspectratio:true";
    } else if (text.startsWith("Export Presets")) {
      queryInput.value = "exportpreset:true";
    } else if (text.startsWith("Recent Searches")) {
      // Just clear search or show command palette
      showCommandPalette();
      return;
    } else if (text.startsWith("Favorites")) {
      queryInput.value = "favorite:true";
    } else if (text.startsWith("Smart Collections")) {
      queryInput.value = "collection:true";
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
    activeQueries = [queryInput.value];
    queryInput.value = "";
    renderActiveChips();
    runSearch(activeQueries[0]);
  });
});

// AI Toggle click
const aiToggleEl = document.querySelector(".ai-toggle");
if (aiToggleEl) {
  aiToggleEl.addEventListener("click", () => {
    aiSearchEnabled = !aiSearchEnabled;
    aiToggleEl.classList.toggle("active", aiSearchEnabled);
    runSearch(document.getElementById("query").value);
  });
}

// Auto-select toggle
document.getElementById("auto-select-chk").addEventListener("change", (e) => {
  autoSelectEnabled = e.target.checked;
});

// Search input will now be handled by Run button and Enter key
document.getElementById("query").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.querySelector(".btn-ai-run").click();
  }
});

// Rescan button
const btnRescan = document.getElementById("btn-rescan");
if (btnRescan) {
  btnRescan.addEventListener("click", async () => {
    btnRescan.innerHTML = `<span class="spinner" style="width:12px;height:12px"></span> Scanning...`;
    btnRescan.style.pointerEvents = "none";
    await pollProject(true);
    // Refresh current view if needed
    const activeView = document.querySelector("#view-seg .active");
    if (activeView) switchView(activeView.dataset.view || 'table');
    btnRescan.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> Scan Again`;
    btnRescan.style.pointerEvents = "auto";
  });
}

// View switching via seg buttons
document.querySelectorAll('#view-seg button').forEach(btn => {
  btn.addEventListener('click', () => {
    switchView(btn.dataset.view || 'table');
  });
});

let activeQueries = [];

function renderActiveChips() {
  const container = document.getElementById("active-chips-container");
  const label = document.getElementById("active-label");
  const sep = document.getElementById("active-sep");
  if (!container) return;
  
  if (activeQueries.length === 0) {
    container.innerHTML = "";
    if (label) label.style.display = "none";
    if (sep) sep.style.display = "none";
    return;
  }
  
  if (label) label.style.display = "inline";
  if (sep) sep.style.display = "inline";
  
  container.innerHTML = activeQueries.map((q, idx) => `
    <span class="chip">${escapeHtmlMain(q)} <button data-idx="${idx}" class="btn-remove-chip">✕</button></span>
  `).join("");
  
  container.querySelectorAll(".btn-remove-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      activeQueries.splice(idx, 1);
      renderActiveChips();
      document.querySelector(".btn-ai-run").click(); // re-run without the chip
    });
  });
}

// Run button
const btnRun = document.querySelector(".btn-ai-run");
if (btnRun) {
  btnRun.addEventListener("click", async () => {
    const qInput = document.getElementById("query");
    const val = qInput.value.trim();
    if (val) {
      activeQueries.push(val);
      qInput.value = "";
    }
    renderActiveChips();
    
    // Show Loading state
    const originalText = btnRun.innerHTML;
    btnRun.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="spin"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> Running...`;
    
    // Wait a tick to let UI paint loading
    await new Promise(r => setTimeout(r, 50));
    
    // Run Search with all active queries
    const fullQuery = activeQueries.join(" ");
    runSearch(fullQuery);
    
    // Restore button
    btnRun.innerHTML = originalText;
  });
}

// ============ BATCH EDIT INTERACTIVE MODAL ============
function openBatchEditModal(clips) {
  // 1. Scan all matched clips to build an effect → property → values map
  // Uses effectParamGroups from ExtendScript which maps effectDisplayName → [squashedKey1, ...]
  const effectTree = new Map(); // effectName → Map(propDisplayName → { squashed, values: Set, type })
  
  clips.forEach(clip => {
    if (!clip.effectParams || !clip.effectParamNames) return;
    
    // Use effectParamGroups if available (maps componentDisplayName → [squashedKeys])
    const groups = clip.effectParamGroups || {};
    
    for (const effectName in groups) {
      const keys = groups[effectName];
      if (!keys || !keys.length) continue;
      
      if (!effectTree.has(effectName)) {
        effectTree.set(effectName, new Map());
      }
      const propMap = effectTree.get(effectName);
      
      for (var ki = 0; ki < keys.length; ki++) {
        const squashed = keys[ki];
        const displayName = clip.effectParamNames[squashed];
        const value = clip.effectParams[squashed];
        if (!displayName) continue;
        
        if (!propMap.has(displayName)) {
          propMap.set(displayName, { squashed, values: new Set(), type: "unknown" });
        }
        
        const entry = propMap.get(displayName);
        if (value !== undefined && value !== null && value !== "") {
          entry.values.add(String(value));
        }
        
        // Detect type
        const strVal = String(value).toLowerCase();
        if (strVal === "true" || strVal === "false") {
          entry.type = "boolean";
        } else if (typeof value === "string" && value.includes(",")) {
          entry.type = "text"; // arrays represented as comma-separated strings
        } else if (typeof value === "number" || (!isNaN(parseFloat(value)) && value !== "")) {
          if (entry.type !== "boolean") entry.type = "number";
        } else if (typeof value === "string" && value !== "") {
          if (entry.type === "unknown") entry.type = "text";
        }
      }
    }
  });

  // 2. Build the modal HTML
  const effectNames = Array.from(effectTree.keys()).sort((a, b) => {
    // Put Motion and Opacity first, Audio second
    const priority = ["Motion", "Opacity", "Volume", "Audio Clip Mixer"];
    const aIdx = priority.indexOf(a);
    const bIdx = priority.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.localeCompare(b);
  });

  const overlay = document.createElement("div");
  overlay.className = "batch-modal-overlay";
  overlay.innerHTML = `
    <div class="batch-modal">
      <div class="batch-modal-header">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
        <span class="batch-modal-title">Batch Edit Properties</span>
        <span class="batch-modal-subtitle">${clips.length} clip${clips.length !== 1 ? "s" : ""}</span>
        <button class="batch-modal-close" id="bm-close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <div class="batch-modal-body">
        <div class="batch-effect-tree">
          <div class="batch-tree-label">Effects Detected</div>
          <div class="batch-effect-list" id="bm-effects">
            ${effectNames.map((name, i) => {
              const count = effectTree.get(name).size;
              return `<div class="batch-effect-chip${i === 0 ? ' active' : ''}" data-effect="${escapeHtmlMain(name)}">
                <span>✨</span> ${escapeHtmlMain(name)} <span class="chip-count">${count}</span>
              </div>`;
            }).join("")}
          </div>
        </div>
        <div class="batch-prop-area" id="bm-props">
          <!-- populated dynamically -->
        </div>
        <div class="batch-value-editor" id="bm-editor" style="display:none;">
          <!-- populated when a property is selected -->
        </div>
      </div>
      <div class="batch-modal-footer">
        <span class="batch-footer-info" id="bm-info">Select a property to edit</span>
        <button class="batch-cancel-btn" id="bm-cancel">Cancel</button>
        <button class="batch-apply-btn" id="bm-apply" disabled>Apply Changes</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // State
  let selectedEffect = effectNames[0] || null;
  let selectedProp = null; // { displayName, squashed, type, values }

  function renderProps() {
    const area = document.getElementById("bm-props");
    if (!selectedEffect || !effectTree.has(selectedEffect)) {
      area.innerHTML = `<div class="batch-prop-empty">No properties detected</div>`;
      return;
    }
    const propMap = effectTree.get(selectedEffect);
    const entries = Array.from(propMap.entries());
    
    if (entries.length === 0) {
      area.innerHTML = `<div class="batch-prop-empty">No properties found for this effect</div>`;
      return;
    }

    area.innerHTML = entries.map(([displayName, info]) => {
      const valArr = Array.from(info.values);
      const valPreview = valArr.length > 3 
        ? valArr.slice(0, 3).join(", ") + "…" 
        : valArr.join(", ");
      const typeLabel = info.type === "boolean" ? "BOOL" : info.type === "number" ? "NUM" : "TEXT";
      const isSelected = selectedProp && selectedProp.displayName === displayName;
      
      return `<div class="batch-prop-row${isSelected ? ' selected' : ''}" data-prop="${escapeHtmlMain(displayName)}">
        <span class="batch-prop-name">${escapeHtmlMain(displayName)}</span>
        <span class="batch-prop-val">${escapeHtmlMain(valPreview) || "—"}</span>
        <span class="batch-prop-type">${typeLabel}</span>
      </div>`;
    }).join("");

    // Attach click handlers
    area.querySelectorAll(".batch-prop-row").forEach(row => {
      row.addEventListener("click", () => {
        const propName = row.dataset.prop;
        const info = propMap.get(propName);
        selectedProp = { displayName: propName, ...info };
        
        // Update selection UI
        area.querySelectorAll(".batch-prop-row").forEach(r => r.classList.remove("selected"));
        row.classList.add("selected");
        
        renderValueEditor();
        document.getElementById("bm-apply").disabled = false;
      });
    });
  }

  function renderValueEditor() {
    const editor = document.getElementById("bm-editor");
    if (!selectedProp) {
      editor.style.display = "none";
      return;
    }
    editor.style.display = "";

    const valArr = Array.from(selectedProp.values);
    let valStr = "";
    if (valArr.length === 1) valStr = valArr[0];
    else if (valArr.length > 1) {
      if (selectedProp.type === "text" && valArr.some(v => v.includes(","))) valStr = "Mixed";
      else valStr = valArr.join(", ");
    }
    const mixedHint = valArr.length > 1 ? ` (mixed: ${valStr})` : "";

    if (selectedProp.type === "boolean") {
      const isTrueNow = valArr.some(v => v.toLowerCase() === "true" || v === "1");
      const isFalseNow = valArr.some(v => v.toLowerCase() === "false" || v === "0");
      editor.innerHTML = `
        <div class="batch-value-row">
          <span class="batch-value-label">${escapeHtmlMain(selectedProp.displayName)}</span>
          <div class="batch-toggle-group" id="bm-toggle">
            <button class="batch-toggle-btn${isTrueNow && !isFalseNow ? ' active' : ''}" data-val="true">✓ True / On</button>
            <button class="batch-toggle-btn${isFalseNow && !isTrueNow ? ' active' : ''}" data-val="false">✗ False / Off</button>
          </div>
        </div>
      `;
      editor.querySelectorAll(".batch-toggle-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          editor.querySelectorAll(".batch-toggle-btn").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
        });
      });
    } else {
      editor.innerHTML = `
        <div class="batch-value-row">
          <span class="batch-value-label">New Value</span>
          <input class="batch-value-input" id="bm-val-input" type="${selectedProp.type === 'number' ? 'number' : 'text'}" 
                 placeholder="${selectedProp.type === 'number' ? 'Enter number' : 'Enter value (e.g. 1920, 1080)'}${escapeHtmlMain(mixedHint)}" 
                 value="${escapeHtmlMain(valStr === 'Mixed' ? '' : valStr)}" />
        </div>
      `;
      // Auto-focus the input
      setTimeout(() => {
        const inp = document.getElementById("bm-val-input");
        if (inp) { inp.focus(); inp.select(); }
      }, 50);
    }

    document.getElementById("bm-info").innerHTML = `Editing <b>${escapeHtmlMain(selectedProp.displayName)}</b> on <b>${clips.length}</b> clips`;
  }

  // Render initial props
  renderProps();

  // Effect chip click handlers
  document.getElementById("bm-effects").querySelectorAll(".batch-effect-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.getElementById("bm-effects").querySelectorAll(".batch-effect-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      selectedEffect = chip.dataset.effect;
      selectedProp = null;
      document.getElementById("bm-editor").style.display = "none";
      document.getElementById("bm-apply").disabled = true;
      document.getElementById("bm-info").textContent = "Select a property to edit";
      renderProps();
    });
  });

  // Close handlers
  function closeModal() {
    overlay.classList.add("closing");
    setTimeout(() => overlay.remove(), 200);
  }
  document.getElementById("bm-close").addEventListener("click", closeModal);
  document.getElementById("bm-cancel").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  // Apply handler
  document.getElementById("bm-apply").addEventListener("click", async () => {
    if (!selectedProp) return;
    const applyBtn = document.getElementById("bm-apply");
    applyBtn.disabled = true;
    applyBtn.innerHTML = `<span class="spinner"></span>Applying…`;

    // Get value
    let finalVal, isString = true;
    if (selectedProp.type === "boolean") {
      const activeToggle = document.querySelector("#bm-toggle .batch-toggle-btn.active");
      if (!activeToggle) { applyBtn.innerHTML = "Apply Changes"; applyBtn.disabled = false; return; }
      finalVal = activeToggle.dataset.val === "true" ? 1 : 0;
      isString = false;
    } else {
      const inp = document.getElementById("bm-val-input");
      const rawVal = inp ? inp.value.trim() : "";
      if (rawVal === "") { applyBtn.innerHTML = "Apply Changes"; applyBtn.disabled = false; return; }
      
      if (!isNaN(parseFloat(rawVal)) && isFinite(rawVal)) {
        finalVal = parseFloat(rawVal);
        isString = false;
      } else if (rawVal.toLowerCase() === "true" || rawVal.toLowerCase() === "on") {
        finalVal = 1;
        isString = false;
      } else if (rawVal.toLowerCase() === "false" || rawVal.toLowerCase() === "off") {
        finalVal = 0;
        isString = false;
      } else {
        finalVal = rawVal;
      }
    }

    const idsToEdit = Array.from(selectedIds.size > 0 ? selectedIds : new Set(clips.map(c => c.id)));
    
    try {
      const res = await evalHost("batchSetEffectProperty", JSON.stringify(idsToEdit), selectedEffect, selectedProp.squashed, finalVal, isString);
      if (res && res.success) {
        applyBtn.innerHTML = "✓ Applied!";
        applyBtn.style.background = "var(--green)";
        
        // Optimistic UI update: instantly update the local snapshot so the UI feels fast
        idsToEdit.forEach(id => {
          const c = lastSnapshot.find(cl => cl.id === id);
          if (c && c.effectParams) {
            // Check if it's an array property (like Position: [1920, 1080])
            if (Array.isArray(c.effectParams[selectedProp.squashed]) && typeof finalVal === 'string') {
                const parts = finalVal.split(',').map(n => parseFloat(n.trim()));
                c.effectParams[selectedProp.squashed] = parts;
            } else {
                c.effectParams[selectedProp.squashed] = finalVal;
            }
          }
        });
        
        // Re-filter clips so it picks up the optimistically updated values
        clips = lastSnapshot.filter(c => idsToEdit.includes(c.id) || clips.some(m => m.id === c.id));
        
        // Rerender current effect's props with fresh values
        renderProps();
        
        // Kick off a background poll to sync true state, but no need to await it
        pollProject(true);
        applyBtn.innerHTML = "Apply Changes";
        applyBtn.disabled = false;
        applyBtn.style.background = "";
      } else {
        applyBtn.innerHTML = "Apply Changes";
        applyBtn.disabled = false;
        applyBtn.style.background = "";
        alert("Error: " + (res ? res.error : "Unknown error"));
      }
    } catch (err) {
      applyBtn.innerHTML = "Apply Changes";
      applyBtn.disabled = false;
      alert("Error: " + err);
    }
  });
}

// Batch actions panel
document.getElementById("batch-actions").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const action = btn.dataset.action;
  if (!action) return;
  const currentMatches = lastSnapshot.filter(c => matchIds.has(c.id));

  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation: batchSpin 1s linear infinite; display: inline-block; vertical-align: middle; margin-right: 6px;"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> Working...`;
  btn.style.pointerEvents = "none";
  
  const minDelay = new Promise(r => setTimeout(r, 800));

  try {
    if (action === "batch-edit") {
      const clipsToEdit = selectedIds.size > 0 
        ? lastSnapshot.filter(c => selectedIds.has(c.id))
        : currentMatches;
      openBatchEditModal(clipsToEdit);
      return;
    } else if (action === "select-all") {
      selectedIds = new Set(currentMatches.map(c => c.id));
      await evalHost("ffs_selectClips", JSON.stringify(Array.from(selectedIds)));
    } else if (action === "reveal-first") {
      if (selectedIds.size > 0) {
        // Only select the first one to make it fast
        const arr = Array.from(selectedIds).slice(0, 1);
        if (arr[0].startsWith("proj_")) {
          const nodeIds = arr.map(id => id.replace("proj_", ""));
          await evalHost("ffs_selectProjectItems", JSON.stringify(nodeIds));
        } else {
          await evalHost("ffs_selectClips", JSON.stringify(arr));
        }
      } else if (currentMatches[0]) {
        selectedIds = new Set([currentMatches[0].id]);
        if (currentMatches[0].id.startsWith("proj_")) {
          await evalHost("ffs_selectProjectItems", JSON.stringify([currentMatches[0].nodeId]));
        } else {
          await evalHost("ffs_selectClips", JSON.stringify(Array.from(selectedIds)));
        }
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
    await minDelay;
  } finally {
    btn.innerHTML = originalHtml;
    btn.style.pointerEvents = "auto";
  }

  runSearch(lastQuery, { rerenderOnly: true });
  window.ffsRerenderTimeline();
});

// Add refresh button handler
const refreshBtn = document.getElementById("refresh-btn");
if (refreshBtn) {
  refreshBtn.addEventListener("click", () => {
    const svg = refreshBtn.querySelector("svg");
    if (svg) svg.style.animation = "batchSpin 1s linear infinite";
    
    pollProject(true).finally(() => {
      if (svg) svg.style.animation = "";
    });
  });
}

// Initial render of saved searches badge
renderSavedSearches();
renderActiveChips();

// Initial rendering with cached data, then start polling
if (lastSnapshot.length > 0 || lastProjectAssets.length > 0) {
  runSearch(document.getElementById("query").value);
  window.ffsRerenderTimeline();
  updateAnalytics();
  updatePerformanceScanner();
}
pollProject(true);
setInterval(() => pollProject(), POLL_MS);

// Inspector Tab Switching
document.querySelectorAll(".insp-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".insp-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    
    const text = tab.textContent;
    const motion = document.getElementById("insp-motion");
    const audio = document.getElementById("insp-audio");
    const effects = document.getElementById("insp-effects");
    const usage = document.getElementById("insp-usage");
    const metadata = document.getElementById("insp-metadata");
    
    if (motion) motion.classList.toggle("hidden", text !== "Properties");
    if (audio) audio.classList.toggle("hidden", text !== "Properties");
    if (effects) effects.classList.toggle("hidden", text !== "Properties");
    
    if (usage) usage.classList.toggle("hidden", text !== "Usage");
    if (metadata) metadata.classList.toggle("hidden", text !== "Metadata");
  });
});

// Suggested ghost chips
document.querySelectorAll(".chip.ghost").forEach(chip => {
  chip.addEventListener("click", () => {
    const text = chip.textContent.replace("+ ", "").trim();
    activeQueries.push(text);
    renderActiveChips();
    document.querySelector(".btn-ai-run").click();
});
});

// Debug shortcut: Ctrl+Shift+D to dump snapshot to disk
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === "D") {
    try {
      const fs = require("fs");
      fs.writeFileSync("C:/Users/fahad/.gemini/antigravity-ide/brain/3e9ad082-6137-41a2-aa51-f77369a75d9d/scratch/dump.json", JSON.stringify(lastSnapshot, null, 2));
      alert("Snapshot dumped to scratch dir!");
    } catch (err) {
      alert("Dump failed: " + err);
    }
  }
});


// --- Panel Resizer Logic ---
const sidebarResizer = document.getElementById('sidebar-resizer');
const inspectorResizer = document.getElementById('inspector-resizer');
const sidebar = document.querySelector('.sidebar');
const inspector = document.querySelector('.inspector');

if (sidebarResizer && sidebar) {
  let isResizingSidebar = false;
  let startX = 0;
  let startWidth = 0;

  sidebarResizer.addEventListener('mousedown', (e) => {
    isResizingSidebar = true;
    startX = e.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    document.body.style.cursor = 'ew-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizingSidebar) return;
    const dx = e.clientX - startX;
    const newWidth = Math.max(150, Math.min(startWidth + dx, 500));
    sidebar.style.width = newWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isResizingSidebar) {
      isResizingSidebar = false;
      document.body.style.cursor = '';
    }
  });
}

if (inspectorResizer && inspector) {
  let isResizingInspector = false;
  let startX = 0;
  let startWidth = 0;

  inspectorResizer.addEventListener('mousedown', (e) => {
    isResizingInspector = true;
    startX = e.clientX;
    startWidth = inspector.getBoundingClientRect().width;
    document.body.style.cursor = 'ew-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizingInspector) return;
    const dx = startX - e.clientX; // Inverted because it's on the right
    const newWidth = Math.max(150, Math.min(startWidth + dx, 600));
    inspector.style.width = newWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isResizingInspector) {
      isResizingInspector = false;
      document.body.style.cursor = '';
    }
  });
}
