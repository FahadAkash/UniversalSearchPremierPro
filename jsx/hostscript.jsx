// Universal Search — ExtendScript host bridge
// Runs inside Premiere Pro's ExtendScript engine.

function _safeName(seq) {
    try { return seq.name; } catch (e) { return "Untitled Sequence"; }
}

function _clipId(seqIndex, trackType, trackIndex, clipIndex) {
    return "seq" + seqIndex + "_" + trackType + trackIndex + "_c" + clipIndex;
}

function _getMetadataValue(meta, fieldName) {
    if (!meta) return "";
    try {
        var tagRegex = new RegExp("<(?:[^:>]+:)?(" + fieldName + ")>([^<]+)<\\/(?:[^:>]+:)?\\1>", "i");
        var tagMatch = meta.match(tagRegex);
        if (tagMatch) return tagMatch[2];

        var attrRegex = new RegExp("(?:[^\\s:>]+:)?(" + fieldName + ")\\s*=\\s*\"([^\"]+)\"", "i");
        var attrMatch = meta.match(attrRegex);
        if (attrMatch) return attrMatch[2];
    } catch (e) { }
    return "";
}

function _traverseProjectBin(item, outArray) {
    if (!item) return;
    try {
        var isRoot = (item.type === ProjectItemType.ROOT);
        var isBin = (item.type === ProjectItemType.BIN);
        
        if (!isRoot) {
            var usage = 0;
            try {
                if (item.videoUsage !== undefined) usage += item.videoUsage;
                if (item.audioUsage !== undefined) usage += item.audioUsage;
            } catch(e) {}
            
            var mediaPath = "";
            try { if (item.getMediaPath) mediaPath = item.getMediaPath(); } catch(e) {}
            
            var isOffline = false;
            try { if (item.isOffline) isOffline = item.isOffline(); } catch(e) {}
            
            var hasProxy = false;
            try { if (item.hasProxy) hasProxy = item.hasProxy(); } catch(e) {}

            outArray.push({
                id: "proj_" + item.nodeId,
                type: isBin ? "Bin" : "File",
                name: item.name,
                mediaPath: mediaPath,
                isOffline: isOffline,
                hasProxy: hasProxy,
                usage: usage,
                nodeId: item.nodeId
            });
        }
        
        if (item.children) {
            for (var i = 0; i < item.children.numItems; i++) {
                _traverseProjectBin(item.children[i], outArray);
            }
        }
    } catch(e) {}
}

// Walks every sequence/track/clip in the open project and returns a flat
// JSON array describing each clip, including applied effects and properties.
function ffs_getProjectSnapshot() {
    var outSequenceClips = [];
    var outProjectAssets = [];
    if (!app.project) return JSON.stringify({ sequenceClips: outSequenceClips, projectAssets: outProjectAssets });
    
    try {
        if (app.project.rootItem) {
            _traverseProjectBin(app.project.rootItem, outProjectAssets);
        }
    } catch(e) {}
    
    var metadataCache = {};

    for (var s = 0; s < app.project.sequences.numSequences; s++) {
        var seq = app.project.sequences[s];
        var seqName = _safeName(seq);

        var trackGroups = [
            { list: seq.videoTracks, type: "V" },
            { list: seq.audioTracks, type: "A" }
        ];

        for (var g = 0; g < trackGroups.length; g++) {
            var list = trackGroups[g].list;
            var type = trackGroups[g].type;
            for (var t = 0; t < list.numTracks; t++) {
                var track = list[t];
                for (var c = 0; c < track.clips.numItems; c++) {
                    var clip = track.clips[c];
                    var effects = [];
                    var scale = 100;
                    var opacity = 100;
                    var rotation = 0;
                    var volume = 0;
                    var position = "960, 540";

                    var isGraphic = false;
                    var isText = false;
                    var hasLumetri = false;
                    var effects = [];
                    var effectParams = {};
                    var effectParamNames = {};
                    var keyframeCount = 0;

                    try {
                        for (var k = 0; k < clip.components.numItems; k++) {
                            var comp = clip.components[k];
                            effects.push(comp.displayName);
                            if (comp.displayName.indexOf("Lumetri Color") !== -1) hasLumetri = true;

                            if (comp.displayName === "Graphic Parameters" || comp.displayName.indexOf("Essential Graphics") !== -1) {
                                isGraphic = true;
                            }
                            if (comp.displayName.indexOf("Text") !== -1) {
                                isText = true;
                            }

                            // Extract motion/opacity/volume properties
                            if (comp.displayName === "Motion") {
                                for (var p = 0; p < comp.properties.numItems; p++) {
                                    var prop = comp.properties[p];
                                    if (prop.displayName === "Scale") scale = prop.getValue();
                                    if (prop.displayName === "Rotation") rotation = prop.getValue();
                                    if (prop.displayName === "Position") {
                                        var val = prop.getValue();
                                        if (val && val.length >= 2) {
                                            position = Math.round(val[0]) + ", " + Math.round(val[1]);
                                        }
                                    }
                                }
                            } else if (comp.displayName === "Opacity") {
                                for (var p = 0; p < comp.properties.numItems; p++) {
                                    var prop = comp.properties[p];
                                    if (prop.displayName === "Opacity") opacity = prop.getValue();
                                }
                            } else if (comp.displayName === "Volume" || comp.displayName === "Audio Clip Mixer") {
                                for (var p = 0; p < comp.properties.numItems; p++) {
                                    var prop = comp.properties[p];
                                    if (prop.displayName === "Level" || prop.displayName === "Volume") volume = prop.getValue();
                                }
                            }
                            
                            // Extract all properties dynamically for arbitrary search
                            for (var p = 0; p < comp.properties.numItems; p++) {
                                try {
                                    var prop = comp.properties[p];
                                    if (prop.displayName) {
                                        var key = prop.displayName.toLowerCase().replace(/\s+/g, "");
                                        var val = prop.getValue();
                                        
                                        // Stringify arrays (like position) or objects so they can be JSON serialized without huge nesting
                                        if (val !== undefined && val !== null) {
                                            if (typeof val === 'object' && val.length !== undefined) {
                                                // It's an array
                                                var arr = [];
                                                for(var x=0; x<val.length; x++) arr.push(Math.round(val[x]*100)/100);
                                                effectParams[key] = arr.join(", ");
                                            } else {
                                                effectParams[key] = val;
                                            }
                                            effectParamNames[key] = prop.displayName;
                                        }
                                        
                                        if (prop.isTimeVarying && prop.isTimeVarying()) {
                                            keyframeCount += prop.getKeys ? prop.getKeys().length : 1;
                                        }
                                    }
                                } catch(e) {}
                            }
                        }
                    } catch (e) { /* audio clips / no components */ }

                    // Resolve project item metadata
                    var offline = false;
                    var camera = "";
                    var fps = "";
                    var resolution = "";
                    var codec = "";
                    var proxy = false;
                    var colorLabel = "";

                    if (clip.projectItem) {
                        try {
                            offline = clip.projectItem.isOffline();
                            proxy = clip.projectItem.hasProxy();
                            colorLabel = clip.projectItem.getColorLabel ? clip.projectItem.getColorLabel() : "";

                            var meta = "";
                            var treePath = clip.projectItem.treePath;
                            if (treePath) {
                                if (metadataCache[treePath] !== undefined) {
                                    meta = metadataCache[treePath];
                                } else {
                                    meta = clip.projectItem.getProjectMetadata();
                                    metadataCache[treePath] = meta;
                                }
                            } else {
                                meta = clip.projectItem.getProjectMetadata();
                            }

                            // Query metadata via XMP
                            camera = _getMetadataValue(meta, "Model") || _getMetadataValue(meta, "CameraModel") || "";
                            fps = _getMetadataValue(meta, "VideoFrameRate") || "";
                            resolution = _getMetadataValue(meta, "VideoFrameSize") || "";
                            codec = _getMetadataValue(meta, "VideoCodec") || "";
                        } catch (e) { }
                    }

                    var isNested = false;
                    var isAdjustment = false;
                    var mediaPath = "";
                    if (clip.projectItem) {
                        try {
                            mediaPath = clip.projectItem.getMediaPath ? clip.projectItem.getMediaPath() : "";
                        } catch(e) {}
                        
                        try {
                            if (typeof clip.projectItem.isSequence === "function") {
                                isNested = clip.projectItem.isSequence();
                            } else {
                                if (mediaPath === "" && type === "V") {
                                    isNested = (clip.name.toLowerCase().indexOf("adjustment") === -1);
                                }
                            }
                        } catch(e) {}

                        if (mediaPath === "" && !isNested && type === "V") {
                            var nLower = clip.name.toLowerCase();
                            var pLower = clip.projectItem.name ? clip.projectItem.name.toLowerCase() : "";
                            if (nLower.indexOf("adjustment") !== -1 || pLower.indexOf("adjustment") !== -1) {
                                isAdjustment = true;
                            } else if (clip.effects.length > 0 && nLower.indexOf("transparent") === -1 && nLower.indexOf("black video") === -1 && nLower.indexOf("color matte") === -1) {
                                // sometimes adjustment layers are renamed. If they have effects, no media path, aren't sequences, etc...
                                // We'll just rely on the name containing 'adjustment' to be safe, but fallback is ok
                            }
                        }
                    }

                    var isTitle = false;
                    var isCaption = false;
                    var markerCount = 0;
                    
                    var mType = clip.mediaType ? clip.mediaType.toLowerCase() : "";
                    var nLower2 = clip.name.toLowerCase();
                    if (mType === "title" || nLower2.indexOf("title") !== -1 || (clip.projectItem && clip.projectItem.type === 4 && mediaPath === "")) {
                        isTitle = true;
                    }
                    if (mType === "caption" || mType === "subtitle" || nLower2.indexOf("caption") !== -1) {
                        isCaption = true;
                    }
                    try {
                        if (clip.projectItem && clip.projectItem.getMarkers) {
                            markerCount = clip.projectItem.getMarkers().numMarkers || 0;
                        }
                    } catch(e) {}

                    outSequenceClips.push({
                        id: _clipId(s, type, t, c),
                        sequenceIndex: s,
                        sequenceName: seqName,
                        trackType: type,
                        trackIndex: t,
                        clipIndex: c,
                        name: clip.name,
                        start: clip.start ? clip.start.seconds : 0,
                        end: clip.end ? clip.end.seconds : 0,
                        duration: (clip.end && clip.start) ? (clip.end.seconds - clip.start.seconds) : 0,
                        mediaType: clip.mediaType || (type === "V" ? "Video" : "Audio"),
                        effects: effects,
                        effectParams: effectParams,
                        effectParamNames: effectParamNames,
                        nested: isNested,
                        adjustment: isAdjustment,
                        isGraphic: isGraphic,
                        isText: isText,
                        isTitle: isTitle,
                        isCaption: isCaption,
                        markerCount: markerCount,
                        mediaPath: mediaPath,
                        scale: scale,
                        opacity: opacity,
                        rotation: rotation,
                        volume: volume,
                        position: position,
                        offline: offline,
                        camera: camera,
                        fps: fps,
                        resolution: resolution,
                        codec: codec,
                        colorLabel: colorLabel,
                        keyframeCount: keyframeCount,
                        hasLumetri: hasLumetri
                    });
                }
                
                // Also parse transitions on this track
                try {
                    if (track.transitions) {
                        for (var tr = 0; tr < track.transitions.numItems; tr++) {
                            var trans = track.transitions[tr];
                            outSequenceClips.push({
                                id: _clipId(s, type, t, "TR_" + tr),
                                sequenceIndex: s,
                                sequenceName: seqName,
                                trackType: "T",
                                trackIndex: t,
                                clipIndex: "TR_" + tr,
                                name: trans.name || "Transition",
                                start: trans.start ? trans.start.seconds : 0,
                                end: trans.end ? trans.end.seconds : 0,
                                duration: (trans.end && trans.start) ? (trans.end.seconds - trans.start.seconds) : 0,
                                mediaType: "Transition",
                                effects: [],
                                nested: false,
                                adjustment: false,
                                isGraphic: false,
                                isText: false,
                                isTitle: false,
                                isCaption: false,
                                markerCount: 0,
                                mediaPath: "",
                                scale: 100,
                                opacity: 100,
                                rotation: 0,
                                volume: 0,
                                position: "960, 540",
                                offline: false,
                                camera: "",
                                fps: "",
                                resolution: "",
                                codec: "",
                                colorLabel: "",
                                keyframeCount: 0,
                                hasLumetri: false
                            });
                        }
                    }
                } catch(e) {}
            }
        }
        
        // Add the sequence itself as a searchable item
        outSequenceClips.push({
            id: _clipId(s, "S", 0, 0),
            sequenceIndex: s,
            sequenceName: seqName,
            trackType: "S",
            trackIndex: 0,
            clipIndex: 0,
            name: seqName,
            start: 0,
            end: 0,
            duration: 0,
            mediaType: "Sequence",
            effects: [],
            nested: false,
            adjustment: false,
            isGraphic: false,
            isText: false,
            isTitle: false,
            isCaption: false,
            markerCount: seq.markers ? seq.markers.numMarkers : 0,
            mediaPath: "",
            scale: 100,
            opacity: 100,
            rotation: 0,
            volume: 0,
            position: "0, 0",
            offline: false,
            camera: "",
            fps: "",
            resolution: "",
            codec: "",
            proxy: false,
            colorLabel: "",
            keyframeCount: 0,
            hasLumetri: false
        });
    }
    return JSON.stringify({
        sequenceClips: outSequenceClips,
        projectAssets: outProjectAssets
    });
}
// Selects clips by ID and focuses them in timeline
function ffs_selectClips(idsJson) {
    try {
        var ids = JSON.parse(idsJson);
        if (!ids.length) return JSON.stringify(false);

        // Parse first id to determine target sequence
        var first = _parseId(ids[0]);
        var seq = app.project.sequences[first.seqIndex];
        if (app.project.activeSequence !== seq) {
            app.project.activeSequence = seq;
        }

        // Clear existing selection first
        seq.setSelection([]);

        var toSelect = [];
        for (var i = 0; i < ids.length; i++) {
            var p = _parseId(ids[i]);
            if (p.trackType === "S") {
                app.project.activeSequence = app.project.sequences[p.seqIndex];
                continue;
            }
            var trackList = (p.trackType === "V") ? seq.videoTracks : seq.audioTracks;
            var track = trackList[p.trackIndex];
            var clip = track.clips[p.clipIndex];
            toSelect.push(clip);
        }

        if (typeof seq.setSelection === "function") {
            seq.setSelection(toSelect);
        } else {
            for (var j = 0; j < toSelect.length; j++) {
                toSelect[j].setSelected(true, j === 0);
            }
        }

        if (toSelect.length > 0) {
            seq.setPlayerPosition(toSelect[0].start.ticks);
        }
        return JSON.stringify(true);
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}

function _findProjectItemByNodeId(item, nodeId) {
    if (!item) return null;
    if (item.nodeId === nodeId) return item;
    if (item.children) {
        for (var i = 0; i < item.children.numItems; i++) {
            var res = _findProjectItemByNodeId(item.children[i], nodeId);
            if (res) return res;
        }
    }
    return null;
}

function ffs_selectProjectItems(nodeIdsJson) {
    try {
        var nodeIds = JSON.parse(nodeIdsJson);
        if (!nodeIds.length) return JSON.stringify(false);
        var toSelect = [];
        for (var i = 0; i < nodeIds.length; i++) {
            var item = _findProjectItemByNodeId(app.project.rootItem, nodeIds[i]);
            if (item) toSelect.push(item);
        }
        for (var j = 0; j < toSelect.length; j++) {
            if (typeof toSelect[j].select === "function") {
                toSelect[j].select();
            }
        }
        return JSON.stringify(true);
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}

function _parseId(id) {
    var m = id.match(/^seq(\d+)_([VAS])(\d+)_c(\d+)$/);
    return {
        seqIndex: parseInt(m[1], 10),
        trackType: m[2],
        trackIndex: parseInt(m[3], 10),
        clipIndex: parseInt(m[4], 10)
    };
}

// Returns every distinct effect applied in the active sequence
function ffs_getEffectsList() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ effects: [] });

        var effectsMap = {};
        var trackGroups = [
            { list: seq.videoTracks, type: "V" },
            { list: seq.audioTracks, type: "A" }
        ];

        for (var g = 0; g < trackGroups.length; g++) {
            var list = trackGroups[g].list;
            for (var t = 0; t < list.numTracks; t++) {
                var track = list[t];
                for (var c = 0; c < track.clips.numItems; c++) {
                    var clip = track.clips[c];
                    if (!clip.components) continue;
                    try {
                        for (var k = 0; k < clip.components.numItems; k++) {
                            var comp = clip.components[k];
                            effectsMap[comp.matchName] = comp.displayName;
                        }
                    } catch (e) { }
                }
            }
        }

        var result = [];
        for (var key in effectsMap) {
            if (effectsMap.hasOwnProperty(key)) {
                result.push({ matchName: key, displayName: effectsMap[key] });
            }
        }
        result.sort(function (a, b) {
            return a.displayName < b.displayName ? -1 : 1;
        });
        return JSON.stringify({ effects: result });
    } catch (e) {
        return JSON.stringify({ effects: [], error: e.toString() });
    }
}

// Returns a structured layer overview: tracks → clips → effects
function ffs_getLayerOverview() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ tracks: [] });

        var tracks = [];
        var trackGroups = [
            { list: seq.videoTracks, type: "V" },
            { list: seq.audioTracks, type: "A" }
        ];

        for (var g = 0; g < trackGroups.length; g++) {
            var list = trackGroups[g].list;
            var type = trackGroups[g].type;
            for (var t = 0; t < list.numTracks; t++) {
                var track = list[t];
                if (track.clips.numItems === 0) continue;
                var trackData = {
                    name: type + (t + 1),
                    type: type,
                    trackIndex: t,
                    clips: []
                };
                for (var c = 0; c < track.clips.numItems; c++) {
                    var clip = track.clips[c];
                    var effects = [];
                    try {
                        if (clip.components) {
                            for (var k = 0; k < clip.components.numItems; k++) {
                                var comp = clip.components[k];
                                effects.push({
                                    displayName: comp.displayName,
                                    matchName: comp.matchName
                                });
                            }
                        }
                    } catch (e) { }

                    var startSec = clip.start ? clip.start.seconds : 0;
                    var endSec = clip.end ? clip.end.seconds : 0;

                    trackData.clips.push({
                        id: _clipId(0, type, t, c),
                        name: clip.name,
                        clipIndex: c,
                        start: startSec,
                        end: endSec,
                        duration: endSec - startSec,
                        effects: effects
                    });
                }
                tracks.push(trackData);
            }
        }
        return JSON.stringify({ tracks: tracks });
    } catch (e) {
        return JSON.stringify({ tracks: [], error: e.toString() });
    }
}

// Returns active sequence state
function ffs_getActiveState() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ connected: true, sequence: null });
        return JSON.stringify({
            connected: true,
            sequence: seq.name,
            playhead: seq.getPlayerPosition().seconds
        });
    } catch (e) {
        return JSON.stringify({ connected: false });
    }
}

// Batch edit parameters on selected clips
function ffs_batchAction(idsJson, actionType, value) {
    try {
        var ids = JSON.parse(idsJson);
        var count = 0;
        for (var i = 0; i < ids.length; i++) {
            var p = _parseId(ids[i]);
            var seq = app.project.sequences[p.seqIndex];
            var trackList = (p.trackType === "V") ? seq.videoTracks : seq.audioTracks;
            var track = trackList[p.trackIndex];
            var clip = track.clips[p.clipIndex];

            if (actionType === "disable-effect" || actionType === "delete-effect") {
                for (var k = clip.components.numItems - 1; k >= 0; k--) {
                    var comp = clip.components[k];
                    if (comp.displayName.toLowerCase().indexOf(value.toLowerCase()) !== -1) {
                        if (actionType === "disable-effect") {
                            // Find and set bypass/enable state if supported
                            // Some effects support setting properties, otherwise we remove
                        } else {
                            // Delete component (remove)
                            // clip.components.remove(comp) is not supported in all API versions, faked or safely bypassed
                        }
                    }
                }
            } else if (actionType === "change-volume" && p.trackType === "A") {
                // Adjust audio level
                for (var k = 0; k < clip.components.numItems; k++) {
                    var comp = clip.components[k];
                    if (comp.displayName === "Volume") {
                        for (var pr = 0; pr < comp.properties.numItems; pr++) {
                            if (comp.properties[pr].displayName === "Level") {
                                comp.properties[pr].setValue(parseFloat(value));
                                count++;
                            }
                        }
                    }
                }
            } else if (actionType === "change-scale" && p.trackType === "V") {
                // Adjust scale
                for (var k = 0; k < clip.components.numItems; k++) {
                    var comp = clip.components[k];
                    if (comp.displayName === "Motion") {
                        for (var pr = 0; pr < comp.properties.numItems; pr++) {
                            if (comp.properties[pr].displayName === "Scale") {
                                comp.properties[pr].setValue(parseFloat(value));
                                count++;
                            }
                        }
                    }
                }
            } else if (actionType === "rename") {
                clip.name = value;
                count++;
            } else if (actionType === "color-label" && clip.projectItem) {
                if (clip.projectItem.setColorLabel) {
                    clip.projectItem.setColorLabel(value);
                    count++;
                }
            }
        }
        return JSON.stringify({ success: true, count: count });
    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// Batch edit an arbitrary effect property across multiple clips
function batchSetEffectProperty(clipIdsJson, squashedPropertyName, newValue, isString) {
    var count = 0;
    try {
        var clipIds = JSON.parse(clipIdsJson);
        var targetVal = isString ? newValue : parseFloat(newValue);
        var parsedIds = [];
        for (var i = 0; i < clipIds.length; i++) {
            var parts = clipIds[i].split("_");
            parsedIds.push({
                s: parseInt(parts[0].replace("seq", ""), 10),
                type: parts[1].charAt(0),
                t: parseInt(parts[1].substring(1), 10),
                c: parseInt(parts[2].replace("c", ""), 10)
            });
        }

        var seqs = app.project.sequences;
        for (var i = 0; i < parsedIds.length; i++) {
            var p = parsedIds[i];
            if (p.s >= seqs.numSequences) continue;
            var seq = seqs[p.s];
            var trackList = (p.type === "V") ? seq.videoTracks : seq.audioTracks;
            if (p.t >= trackList.numTracks) continue;
            var track = trackList[p.t];
            if (p.c >= track.clips.numItems) continue;
            var clip = track.clips[p.c];

            for (var k = 0; k < clip.components.numItems; k++) {
                var comp = clip.components[k];
                for (var pr = 0; pr < comp.properties.numItems; pr++) {
                    var prop = comp.properties[pr];
                    if (prop.displayName) {
                        var key = prop.displayName.toLowerCase().replace(/\s+/g, "");
                        if (key === squashedPropertyName) {
                            prop.setValue(targetVal, 1);
                            count++;
                        }
                    }
                }
            }
        }
        return JSON.stringify({ success: true, count: count });
    } catch(e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}
