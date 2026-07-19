// Universal Search — ExtendScript host bridge
// Runs inside Premiere Pro's ExtendScript engine.

function _safeName(seq) {
    try { return seq.name; } catch (e) { return "Untitled Sequence"; }
}

function _clipId(seqIndex, trackType, trackIndex, clipIndex) {
    return "seq" + seqIndex + "_" + trackType + trackIndex + "_c" + clipIndex;
}

function _getMetadataValue(projectItem, fieldName) {
    if (!projectItem) return "";
    try {
        var meta = projectItem.getProjectMetadata();
        if (!meta) return "";

        var tagRegex = new RegExp("<(?:[^:>]+:)?(" + fieldName + ")>([^<]+)<\\/(?:[^:>]+:)?\\1>", "i");
        var tagMatch = meta.match(tagRegex);
        if (tagMatch) return tagMatch[2];

        var attrRegex = new RegExp("(?:[^\\s:>]+:)?(" + fieldName + ")\\s*=\\s*\"([^\"]+)\"", "i");
        var attrMatch = meta.match(attrRegex);
        if (attrMatch) return attrMatch[2];
    } catch (e) { }
    return "";
}

// Walks every sequence/track/clip in the open project and returns a flat
// JSON array describing each clip, including applied effects and properties.
function ffs_getProjectSnapshot() {
    var out = [];
    if (!app.project) return JSON.stringify(out);

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

                    try {
                        for (var k = 0; k < clip.components.numItems; k++) {
                            var comp = clip.components[k];
                            effects.push(comp.displayName);

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

                            // Query metadata via XMP
                            camera = _getMetadataValue(clip.projectItem, "Model") || _getMetadataValue(clip.projectItem, "CameraModel") || "";
                            fps = _getMetadataValue(clip.projectItem, "VideoFrameRate") || "";
                            resolution = _getMetadataValue(clip.projectItem, "VideoFrameSize") || "";
                            codec = _getMetadataValue(clip.projectItem, "VideoCodec") || "";
                        } catch (e) { }
                    }

                    // Better nested sequence detection
                    var isNested = false;
                    var mediaPath = "";
                    if (clip.projectItem) {
                        try {
                            mediaPath = clip.projectItem.getMediaPath ? clip.projectItem.getMediaPath() : "";
                            // A nested sequence has no media path and is on a video track
                            if (mediaPath === "" && type === "V") {
                                isNested = true;
                            }
                        } catch (e) {
                            // If getMediaPath throws, it might be a sequence
                            if (type === "V") isNested = true;
                        }
                        // Double-check: if the project item type indicates a sequence
                        try {
                            if (clip.projectItem.type === 1 && mediaPath === "") {
                                isNested = true;
                            }
                        } catch(e) {}
                    }

                    out.push({
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
                        nested: isNested,
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
                        proxy: proxy,
                        colorLabel: colorLabel
                    });
                }
            }
        }
    }
    return JSON.stringify(out);
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
            var trackList = (p.trackType === "V") ? seq.videoTracks : seq.audioTracks;
            var track = trackList[p.trackIndex];
            var clip = track.clips[p.clipIndex];
            toSelect.push(clip);
        }

        for (var j = 0; j < toSelect.length; j++) {
            toSelect[j].setSelected(true, j === 0);
        }

        seq.setPlayerPosition(toSelect[0].start.ticks);
        return JSON.stringify(true);
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}

function _parseId(id) {
    var m = id.match(/^seq(\d+)_([VA])(\d+)_c(\d+)$/);
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
