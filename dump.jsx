var out = [];
var seq = app.project.activeSequence;
if (seq) {
    var clip = seq.videoTracks[0].clips[0];
    for (var i = 0; i < clip.components.numItems; i++) {
        var comp = clip.components[i];
        if (comp.displayName === "Levels") {
            var cOut = {name: comp.displayName, props: []};
            for (var j = 0; j < comp.properties.numItems; j++) {
                var p = comp.properties[j];
                cOut.props.push({name: p.name, displayName: p.displayName});
            }
            out.push(cOut);
        }
    }
}
var f = new File("C:/Users/fahad/.gemini/antigravity-ide/brain/3e9ad082-6137-41a2-aa51-f77369a75d9d/scratch/dump.json");
f.open("w");
f.write(JSON.stringify(out));
f.close();
