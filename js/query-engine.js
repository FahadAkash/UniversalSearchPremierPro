// Universal Search — query language engine

const SUPPORTED_KEYS = new Set([
  "effect", "duration", "sequence", "nested", "adjustment", "text", "mediatype", "track",
  "camera", "fps", "label", "resolution", "codec", "offline", "proxy",
  "volume", "opacity", "scale", "rotation", "name", "all",
  "graphic", "caption", "title", "textlayer", "hasmarkers",
  "has_effects", "animpresets", "motionmodified", "haskeyframes",
  "audioeffects", "lumetri", "hascolorlabel", "hasfonts", "asset",
  "hascamera", "hasresolution", "hasfps", "hascodec", "favorite", "exportpreset", "aspectratio"
]);

const UNSUPPORTED_KEYS = new Set([
  "intensity", "font", "color", "transition", "rendercost", "motion", "created"
]);

function parseQuery(raw) {
  const tokens = [];
  // Matches key:value or key>=value, key<=value, key>value, key<value, key!=value, key=value
  const re = /(\w[\w.]*)?\s*(>=|<=|>|<|!=|:|=)\s*("([^"]*)"|[^\s]+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    tokens.push({ 
      key: (m[1] || "text").toLowerCase(), 
      op: m[2], 
      value: (m[4] !== undefined ? m[4] : m[3]) 
    });
  }
  // fallback: bare text search if nothing matched a key:value pattern
  if (tokens.length === 0 && raw.trim().length > 0) {
    tokens.push({ key: "text", op: ":", value: raw.trim() });
  }
  return tokens;
}

function parseDurationToSeconds(str) {
  const m = str.match(/^([\d.]+)\s*(s|sec|m|min)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (/^m|min$/i.test(m[2] || "")) return n * 60;
  return n;
}

// Returns { results: [...clips], unsupported: [keys the user asked for] }
function runQuery(clips, raw) {
  const tokens = parseQuery(raw);
  const unsupported = [];
  let matches = clips;

  tokens.forEach(t => {
    if (UNSUPPORTED_KEYS.has(t.key)) {
      unsupported.push(t.key);
      return; 
    }

    if (!SUPPORTED_KEYS.has(t.key)) {
      const needle = String(t.value).toLowerCase();
      const op = t.op === ":" ? "=" : t.op;
      
      matches = matches.filter(c => {
        let keyToUse = t.key;
        // Fix for my bad advice about scalewidth:false mapping to uniformscale
        if (keyToUse === "scalewidth" && (needle === "off" || needle === "false" || needle === "on" || needle === "true")) {
          keyToUse = "uniformscale";
        }
        
        if (c.effectParams && c.effectParams[keyToUse] !== undefined) {
          const val = c.effectParams[keyToUse];
          if (needle === "off" || needle === "false") {
            return val === false || val === 0 || val === "0" || val === "false";
          }
          if (needle === "on" || needle === "true") {
            return val === true || val === 1 || val === "1" || val === "true";
          }
          const parsed = parseFloat(needle);
          if (!isNaN(parsed) && typeof val === "number") {
            return compare(val, op, parsed);
          }
          return compare(String(val).toLowerCase(), op, needle);
        }
        // Fallback to name search
        return c.name && c.name.toLowerCase().includes(needle);
      });
      return;
    }

    const needle = String(t.value).toLowerCase();

    if (t.key === "effect") {
      matches = matches.filter(c => c.effects.some(e => e.toLowerCase().includes(needle)));
    } else if (t.key === "duration") {
      const secs = parseDurationToSeconds(t.value);
      if (secs !== null) {
        matches = matches.filter(c => compare(c.duration, t.op, secs));
      }
    } else if (t.key === "sequence") {
      matches = matches.filter(c => c.sequenceName.toLowerCase().includes(needle));
    } else if (t.key === "has_effects") {
      const want = needle === "true";
      matches = matches.filter(c => (c.effects && c.effects.length > 0) === want);
    } else if (t.key === "animpresets" || t.key === "haskeyframes") {
      const want = needle === "true";
      matches = matches.filter(c => (c.keyframeCount > 0) === want);
    } else if (t.key === "motionmodified") {
      const want = needle === "true";
      matches = matches.filter(c => (c.scale !== 100 || c.rotation !== 0 || c.position !== "960, 540") === want);
    } else if (t.key === "audioeffects") {
      const want = needle === "true";
      matches = matches.filter(c => (c.trackType === "A" && c.effects && c.effects.length > 0) === want);
    } else if (t.key === "lumetri") {
      const want = needle === "true";
      matches = matches.filter(c => !!c.hasLumetri === want);
    } else if (t.key === "hascolorlabel") {
      const want = needle === "true";
      matches = matches.filter(c => (c.colorLabel && c.colorLabel !== "0") === want);
    } else if (t.key === "hascamera") {
      matches = matches.filter(c => !!c.camera === (needle === "true"));
    } else if (t.key === "hasresolution") {
      matches = matches.filter(c => !!c.resolution === (needle === "true"));
    } else if (t.key === "hasfps") {
      matches = matches.filter(c => !!c.fps === (needle === "true"));
    } else if (t.key === "hascodec") {
      matches = matches.filter(c => !!c.codec === (needle === "true"));
    } else if (t.key === "favorite") {
      // Favorites not implemented on backend yet, return empty for now
      matches = [];
    } else if (t.key === "aspectratio" || t.key === "exportpreset") {
      // Aspect Ratio and Export Presets are unsupported
      unsupported.push(t.key);
      return;
    } else if (t.key === "hasfonts") {
      const want = needle === "true";
      matches = matches.filter(c => !!(c.isText || c.isTitle) === want);
    } else if (t.key === "asset") {
      if (needle === "offline") matches = matches.filter(c => c.isOffline);
      else if (needle === "proxy") matches = matches.filter(c => c.hasProxy);
      else if (needle === "unused") matches = matches.filter(c => c.type === "File" && c.usage === 0);
      else if (needle === "file") matches = matches.filter(c => c.type === "File");
      else if (needle === "bin") matches = matches.filter(c => c.type === "Bin");
      else if (needle === "missingfont") matches = []; // Hardcoded to none for now
      else if (needle === "duplicate") {
        const pathCounts = {};
        matches.forEach(c => {
          if (c.mediaPath) pathCounts[c.mediaPath] = (pathCounts[c.mediaPath] || 0) + 1;
        });
        matches = matches.filter(c => c.mediaPath && pathCounts[c.mediaPath] > 1);
      }
    } else if (t.key === "nested") {
      const want = needle === "true";
      matches = matches.filter(c => !!c.nested === want);
    } else if (t.key === "adjustment") {
      const want = needle === "true";
      matches = matches.filter(c => !!c.adjustment === want);
    } else if (t.key === "graphic") {
      const want = needle === "true";
      matches = matches.filter(c => !!c.isGraphic === want);
    } else if (t.key === "caption") {
      const want = needle === "true";
      matches = matches.filter(c => !!c.isCaption === want);
    } else if (t.key === "title") {
      const want = needle === "true";
      matches = matches.filter(c => !!c.isTitle === want);
    } else if (t.key === "textlayer") {
      const want = needle === "true";
      matches = matches.filter(c => !!c.isText === want);
    } else if (t.key === "hasmarkers") {
      const want = needle === "true";
      matches = matches.filter(c => (c.markerCount > 0) === want);
    } else if (t.key === "text" || t.key === "contains" || t.key === "name") {
      matches = matches.filter(c => c.name.toLowerCase().includes(needle));
    } else if (t.key === "mediatype") {
      // Use trackType since Premiere's clip.mediaType is unreliable
      if (needle === "video" || needle === "v") {
        matches = matches.filter(c => c.trackType === "V");
      } else if (needle === "audio" || needle === "a") {
        matches = matches.filter(c => c.trackType === "A");
      } else if (needle === "sequence") {
        matches = matches.filter(c => c.trackType === "S");
      } else if (needle === "transition") {
        matches = matches.filter(c => c.trackType === "T");
      } else {
        matches = matches.filter(c => c.trackType && c.trackType.toLowerCase() === needle);
      }
    } else if (t.key === "track") {
      matches = matches.filter(c => (c.trackType + c.trackIndex).toLowerCase().includes(needle));
    } else if (t.key === "camera") {
      matches = matches.filter(c => c.camera && c.camera.toLowerCase().includes(needle));
    } else if (t.key === "fps") {
      const val = parseFloat(t.value);
      matches = matches.filter(c => compare(parseFloat(c.fps || 0), t.op === ":" ? "=" : t.op, val));
    } else if (t.key === "label") {
      matches = matches.filter(c => c.colorLabel && c.colorLabel.toLowerCase().includes(needle));
    } else if (t.key === "resolution") {
      matches = matches.filter(c => c.resolution && c.resolution.toLowerCase().includes(needle));
    } else if (t.key === "codec") {
      matches = matches.filter(c => c.codec && c.codec.toLowerCase().includes(needle));
    } else if (t.key === "offline") {
      const want = needle === "true";
      matches = matches.filter(c => !!c.offline === want);
    } else if (t.key === "proxy") {
      const want = needle === "true";
      matches = matches.filter(c => !!c.proxy === want);
    } else if (t.key === "volume") {
      const val = parseFloat(t.value);
      matches = matches.filter(c => compare(c.volume, t.op === ":" ? "=" : t.op, val));
    } else if (t.key === "opacity") {
      const val = parseFloat(t.value);
      matches = matches.filter(c => compare(c.opacity, t.op === ":" ? "=" : t.op, val));
    } else if (t.key === "scale") {
      const val = parseFloat(t.value);
      matches = matches.filter(c => compare(c.scale, t.op === ":" ? "=" : t.op, val));
    } else if (t.key === "rotation") {
      const val = parseFloat(t.value);
      matches = matches.filter(c => compare(c.rotation, t.op === ":" ? "=" : t.op, val));
    }
  });

  return { results: matches, unsupported: [...new Set(unsupported)] };
}

function compare(a, op, b) {
  switch (op) {
    case ">": return a > b;
    case "<": return a < b;
    case ">=": return a >= b;
    case "<=": return a <= b;
    case "!=": return a !== b;
    case "=":
    case ":":
    default: 
      return a === b;
  }
}
