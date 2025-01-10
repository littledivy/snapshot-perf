// MIT License. 2025 Divy Srivastava.

const trace = await Deno.readTextFile("trace.txt");
const events = await Deno.readTextFile("events.txt");

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

const lines = trace.split("\n");
const root = { name: "root", depth: -1, children: [], parent: null };
let current = root;
let currNodeId = 0;
let currFirstScriptNodeId = currNodeId;

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
      nodeId: currNodeId++,
      scriptId: scripts[scripts.length - 1]?.id + 1 ?? -1,
    });

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

  name = name.trim();
  if (name.startsWith("-")) {
    name = name.slice(1);
  }

  const node = {
    name,
    id: currNodeId,
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

const objectTimeThreashold = 0.2;
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

function generateNodeList(node) {
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
    //    data += ` <a class="flright" target="_blank" href='${sourceRoot}#${
    //      nodeDeserdeSources[node.name]
    //    }'><span style="font-size: 0.5em"> [src]</span></a>`;
  }
  if (!node.children.length) {
    return `<li>${data}</li>`;
  }

  const childrenHTML = node.children.map(generateNodeList).join("");
  return `
    <li>
      <details id="${node.id}">
        <summary>${data}</summary>
        <ul>
          ${childrenHTML}
        </ul>
      </details>
    </li>
  `;
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
  <title>Deserialization tracing</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/clusterize.js/0.19.0/clusterize.min.js"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/clusterize.js/0.19.0/clusterize.min.css">
  <style>
    body {
      font-family: monospace;
    }
.tree {
  --spacing: 1.5rem;
  --radius: 5px;
  line-height: 1.5;
}

.tree li {
  display: block;
  position: relative;
  padding-left: calc(2 * var(--spacing) - var(--radius) - 2px);
  content-visibility: auto; /* For performance */
}

.tree ul {
  margin-left: calc(var(--radius) - var(--spacing));
  padding-left: 0;
}

.tree ul li {
  border-left: 2px solid #ddd;
}

.tree ul li:last-child {
  border-color: transparent;
}

.tree ul li::before {
  content: '';
  display: block;
  position: absolute;
  top: calc(var(--spacing) / -2);
  left: -2px;
  width: calc(var(--spacing) + 2px);
  height: calc(var(--spacing) + 1px);
  border: solid #ddd;
  border-width: 0 0 2px 2px;
}

.tree summary {
  display: block;
  cursor: pointer;
}

.tree summary::marker,
.tree summary::-webkit-details-marker {
  display: none;
}

.tree summary:focus {
  outline: none;
}

.tree summary:focus-visible {
  outline: 1px dotted #000;
}

.tree li::after,
.tree summary::before {
  content: '';
  display: block;
  position: absolute;
  top: calc(var(--spacing) / 2 - var(--radius));
  left: calc(var(--spacing) - var(--radius) - 1px);
  width: calc(2 * var(--radius));
  height: calc(2 * var(--radius));
  border-radius: 50%;
  background: #ddd;
}

.tree summary::before {
  z-index: 1;
  background: #696 url('expand-collapse.svg') 0 0;
}

.tree details[open] > summary::before {
  background-position: calc(-2 * var(--radius)) 0;
}
.fright {
  float: right;
}
        body { 
            display: flex; 
            margin: 0; 
	    min-height: 100vh;
	    height: 100%;
        } 
        .column { 
            padding: 15px; 
            box-sizing: border-box; 
        } 
	.maxw50 {
	    max-width: 50vw;
	 }
        .left { 
            background-color: #f8f9fa; 
        } 
        .right { 
            background-color: #e9ecef; 
	    width: 100%;
        } 
	.row {
	    display: flex;
	}
	.top {
	    flex: 1;
	    max-height: 50vh;
	    overflow: auto;
	}
	table
{
word-wrap: break-word;
}

	.bottom {
	    flex: 1;
	    }
	    td, th {
	    padding: 0.5em;
	    text-align: left;
	    }
	    .resize {
   background: #444857;
   width: 1px;
   cursor: col-resize;
   flex-shrink: 0;
   position: relative;
   z-index: 10;
   user-select: none;
}
.resize::before {
   content: "";
   position: absolute;
   top: 50%;
   left: 50%;
   transform: translate(-50%, -50%);
   width: 3px;
   height: 100vh;
   border-inline: 1px solid #fff;
}
    [data-tooltip]:hover::after {
      display: block;
      position: absolute;
      content: attr(data-tooltip);
      border: 1px solid black;
      background: #eee;
      padding: 0.25em;
    }
    .tooltip {
      text-decoration: underline;
      text-decoration-style: dotted;
    }
  </style>
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
  <ul>
    ${generateNodeList(root)}
  </ul>
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
  if(hash) var details = document.getElementById(hash);
  if(details && details.tagName.toLowerCase() === 'details') {
    details.open = true;
    details.scrollIntoView({behavior: 'smooth', block: 'center'});
  }
}
window.addEventListener('hashchange', openTarget);
window.addEventListener('load', openTarget);
</script>
</html>`;

await Deno.writeTextFile("trace.html", html);
console.log("HTML file generated: trace.html");
