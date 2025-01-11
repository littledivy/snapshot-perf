// MIT License. 2025 Divy Srivastava.

const trace = await Deno.readTextFile("trace.txt");

const n = Deno.args[0] || 100;

async function eventMapFor(run) {
  const events = await Deno.readTextFile(`events/events.${run}.txt`);

  const eventLines = events.split("\n");
  let eventMap = {};

  for (let line of eventLines) {
    line = line.trim();
    if (line.startsWith("script")) {
      const [eventName, ...data] = line.split(",");
      if (eventName == "script" && data[0] == "deserialize") {
        const id = parseInt(data[1], 10);
        eventMap[id] = { timestamp: parseFloat(data[2]) };
      }
    }
  }

  return eventMap;
}

// Read events from n different runs and make the final event map which 
// averages the time between the events.
const eventMap = {};
const eventsMaps = [];

for (let i = 0; i < n; i++) {
  eventsMaps.push(await eventMapFor(i));
}

const eventMap0 = eventsMaps[0];

for (const key of Object.keys(eventMap0)) {
  let sum = eventMap0[key].timestamp;
  for (let i = 1; i < n; i++) {
    sum += eventsMaps[i][key].timestamp;
  }
  eventMap[key] = { timestamp: sum / n };
}

const lines = trace.split("\n");
const root = { id: 0, name: "root", depth: -1, children: [], parent: null };
let current = root;
let currNodeId = 0;
let currObjId = 0;
let currFirstScriptNodeId = currNodeId;
let currFirstObjectNodeId = currNodeId;

let objects = [];
const backrefs = {};
let scripts = [];

for (let line of lines) {
  line = line.trim();
  if (line.startsWith("[") || line === "") {
    continue;
  }
  if (line.startsWith("--")) {
    let [_dash, timestamp, ...rest] = line.split(" ");

    timestamp = parseFloat(timestamp);
    if (Number.isNaN(timestamp)) {
      continue;
    }
    const data = rest.join(" ");
    const lastObject = objects[objects.length - 1];

    objects.push({
      timestamp,
      data,
      duration: lastObject ? timestamp - lastObject.timestamp : 0,
      nodeId: currFirstObjectNodeId,
      scriptId: scripts[scripts.length - 1]?.id + 1 ?? -1,
    });
    currFirstObjectNodeId = currNodeId;

    continue;
  }
  if (line.startsWith("script")) {
    const [eventName, ...data] = line.split(",");
    if (eventName == "script-details") {
      const id = parseInt(data[0], 10);
      const name = data[1];
      const script = scripts.find((s) => s.id === id);
      if (script) {
        script.name = name || "Unknown";
        script.nodeId = currFirstScriptNodeId;
        console.log(`+ ${name} (${script.time}ms)`);
      }
      currFirstScriptNodeId = currNodeId + 1;
    }
    if (eventName == "script" && data[0] == "deserialize") {
      const id = parseInt(data[1], 10);
      const prevScript = scripts[scripts.length - 1]?.id;
      const prev = eventMap[prevScript];
      const curr = eventMap[id];

      const time = prev ? (curr.timestamp - prev.timestamp) / 1000 : 0;
      scripts.push({ id, timestamp: curr.timestamp / 1000, time });
    }
    continue;
  }

  if (line.startsWith("(set obj backref")) {
    const backRef = line.split(" ")[3].slice(0, -1).trim();
    current.ref = backRef;
    backrefs[backRef] ??= { node: current, refs: [] };
    backrefs[backRef].node = current;
    continue;
  }

  let [depthStr, name, ...data] = line.split(/(\s+)/).filter((e) =>
    e.trim().length > 0
  );
  const depth = parseInt(depthStr, 16);
  if (Number.isNaN(depth)) {
    continue;
  }

  if (!name) {
    continue;
  }
  name = name.trim();
  if (name.startsWith("-")) {
    name = name.slice(1);
  }

  const node = {
    name,
    id: currNodeId++,
    objId: currObjId,
    data: data.join(" "),
    children: [],
    depth,
    parent: null,
  };

  if (depth > current.depth) {
    current.children.push(node);
    node.parent = current;
  } else {
    while (current.depth >= depth) {
      current = current.parent;
    }
    current.children.push(node);
    node.parent = current;
  }

  current = node;

  if (name == "Backref") {
    const ref = data[0].trim().slice(1, -1).trim();
    backrefs[ref] ??= { node: null, refs: [] };
    backrefs[ref].refs.push(node);

    node.backref = ref;
  }
}

const objectTimeThreashold = 0.1;
const totalObjectTime = objects[objects.length - 1].timestamp -
  objects[0].timestamp;
objects = objects.sort((a, b) => b.duration - a.duration);

const filteredObjs = objects.filter((object) =>
  object.duration > objectTimeThreashold
);
if (filteredObjs.length === 0) {
  objects = objects.slice(0, 10);
} else {
  objects = filteredObjs;
}

const totalScriptTime = scripts[scripts.length - 1].timestamp -
  scripts[0].timestamp;
scripts = scripts.sort((a, b) => b.time - a.time).filter((script) =>
  script.time > 0
);

const sourceRoot =
  "https://chromium.googlesource.com/v8/v8/+/refs/heads/roll/src/snapshot/deserializer.cc";

const nodeDeserdeSources = {
  "NewObject": "1081",
  "RootArray": "1146",
  "ReadOnlyHeapRef": "1120",
  "Backref": "1102",
};

// Delete parent references to avoid circular references
function deleteParent(node) {
  node.id = node.id.toString();
  node.name = nodeName(node);
  delete node.parent;
}
function deleteParents(node) {
  deleteParent(node);
  node.children.forEach(deleteParents);
}
deleteParents(root);

function nodeName(node) {
  let data = escapeHTML(node.name) + escapeHTML(node.data ?? "");
  if (node.ref) {
    const refs = backrefs[node.ref].refs;
    if (refs.length) {
      const refsHTML = refs.map((ref, idx) => {
        return `<sup><a href="#${ref.id}">[${idx}]</a></sup>`;
      }).join("");
      data += `<span id="backref-${node.ref}">${refsHTML}</span>`;
    }
  }
  if (node.backref) {
    data += ` <a href="#backref-${node.backref}">(backref ${node.backref})</a>`;
  }
  if (nodeDeserdeSources[node.name]) {
        //data += ` <a class="flright" target="_blank" href='${sourceRoot}#${
        //  nodeDeserdeSources[node.name]
        //}'><span style="font-size: 0.5em"> [src]</span></a>`;
  }
  
  return data;
}

function escapeHTML(html) {
  return html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replaceAll("Script", "Xscript");
}

function generateTopObjects() {
  return objects.map((object) => {
    const [pointer, ...rest] = object.data.split(" ");
    const data = rest.join(" ");

    return `<tr id="script-${object.scriptId}"><td>${
      (object.duration / totalObjectTime * 100).toFixed(2)
    }</td><td>${
      object.duration.toFixed(3)
    }</td><td><a href="#${object.nodeId}">${pointer}</a> ${
      escapeHTML(data)
    }</td></tr>`;
  });
}

function generateTopScripts() {
  return scripts.map((script) => {
    return `<tr><td>${
      (script.time / totalScriptTime * 100).toFixed(2)
    }</td><td>${
      script.time.toFixed(3)
    }</td><td>${script.name} <a href="#${script.nodeId}" onClick="showScriptObjects(this, '${script.id}')">[*]</a></td></tr>`;
  });
}

// Generate the HTML for the entire tree
const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>deno CLI snapshot</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/infinite-tree/1.18.0/infinite-tree.min.js"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/infinite-tree/1.18.0/infinite-tree.min.css">
  <style>${Deno.readTextFileSync("style.css")}</style>
</head>
<body>
  <div class="column left maxw50">
<table>
    <tr>
      <th>%</th>
      <th><span class="tooltip" data-tooltip="time till deserialize">TTD (ms)</span></th>
      <th>Script</th>
      </tr>
      <tr>
      <td>100.00</td>
      <td>${totalScriptTime.toFixed(3)}</td>
      <td>Total</td>
      </tr>
    ${generateTopScripts().join("")}
  </table>
   </div>
   <div class="resize" id="resize"></div>
  <div class="column right">
  <div class="row top tree">
    Loading...
  </div>
  <hr>
  <div class="row bottom clusterize">
 <table>
    <tr>
      <th>%</th>
      <th><span class="tooltip" data-tooltip="time till deserialize">TTD (ms)</span></th>
      <th>HeapObject</th>
      </tr>
        <tbody id="contentArea">
          ${generateTopObjects().join("")}
	</tbody>
  </table>
  </div>
  </div>
</body>
<script>
var resize = document.querySelector("#resize");
var left = document.querySelector(".left");
var moveX =
   left.getBoundingClientRect().width +
   resize.getBoundingClientRect().width / 2;

var drag = false;
resize.addEventListener("mousedown", function (e) {
   drag = true;
   moveX = e.x;
   console.log("mousedown");
});

document.addEventListener("mousemove", function (e) {
   moveX = e.x;
   if (drag) {
      left.style.width =
         moveX - resize.getBoundingClientRect().width / 2 + "px";
      e.preventDefault();
   }
});

document.addEventListener("mouseup", function (e) {
   drag = false;
});

let currentScriptNode = -1;
function showScriptObjects(e, scriptId) {
  if (currentScriptNode == e) {
    e.parentElement.parentElement.style.backgroundColor = "";
    e.textContent = "[*]";
    currentScriptNode = -1;
  } else {
    e.parentElement.parentElement.style.backgroundColor = "yellow";
    if (currentScriptNode !== -1) {
      currentScriptNode.textContent = "[*]";
      currentScriptNode.parentElement.parentElement.style.backgroundColor = "";
    }

    e.textContent = "[v]";
    currentScriptNode = e;
  }

  var rows = document.querySelectorAll("#contentArea tr");
  rows.forEach(function(row) {
    row.style.display = "table-row";
    if(row.id == "script-" + scriptId || currentScriptNode === -1) {
      row.style.display = "table-row";
    } else {
      row.style.display = "none";
    }
  });
}

function openTarget() {
  var hash = location.hash.substring(1);
  const node = tree.getNodeById(hash);

  if (node) {
    tree.openNode(node);
    tree.scrollToNode(node);
    tree.selectNode(node);
  }
}

window.addEventListener('hashchange', openTarget);

const data = ${JSON.stringify(root)};

const treeEl = document.querySelector('.tree');
treeEl.innerHTML = "";

const tmpDiv = document.createElement('div');
const defaultRenderer = (new InfiniteTree).options.rowRenderer;
const tree = new InfiniteTree({
  el: treeEl,
  autoOpen: true,
  data,
  selectable: true,
  rowRenderer: (node, treeOptions) => {
    const row = defaultRenderer(node, treeOptions);
    tmpDiv.innerHTML = row;

    const contentEl = tmpDiv.querySelector('.infinite-tree-title')
    contentEl.innerHTML = node.name;

    const nodeEl = tmpDiv.querySelector('.infinite-tree-item');
    nodeEl.id = node.objId;
    nodeEl.setAttribute('data-id', node.id);

    return tmpDiv.innerHTML;
  }
});
</script>

</html>`;

await Deno.writeTextFile("trace.html", html);
console.log("HTML file generated: trace.html");
