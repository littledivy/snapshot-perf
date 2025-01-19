// Copyright 2024-2025 Divy Srivastava. See LICENSE file for details.

import cjson from "npm:compressed-json@1.0.16";

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

const ignoreEvents = [
  "v8-version",
  "v8-platform",
  "new",
  "heap-capacity",
  "heap-available",
  "function",
  "compilation-cache",
  "delete",
];

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

  if (line.trim().startsWith("(set obj backref")) {
    const backRef = line.split(" ")[3].slice(0, -1).trim();
    current.ref = backRef;
    backrefs[backRef] ??= { node: current, refs: [] };
    backrefs[backRef].node = current;
    continue;
  }

  const depth = line.indexOf(line.trim());

  line = line.trim();
  let [name, ...data] = line.split(/(\s+)/).filter((e) => e.trim().length > 0);
  if (Number.isNaN(depth) || depth < 0) {
    continue;
  }

  if (!name) {
    continue;
  }
  name = name.trim();

  if (ignoreEvents.find((e) => name.startsWith(e))) {
    continue;
  }

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

const objectTimeThreashold = 0.02;
if (objects.length === 0) {
  objects = [{ timestamp: 0, data: "No objects", duration: 0 }];
}

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
    data += ` <a class="flright" target="_blank" href='${sourceRoot}#${
      nodeDeserdeSources[node.name]
    }'><span style="font-size: 0.5em"> [src]</span></a>`;
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

function nameToGroup(name) {
  if (name.startsWith("node:")) {
    return "deno_node";
  }
  if (name.startsWith("ext:")) {
    return name.split("/")[0].slice(4);
  }
  throw new Error(`Unknown group for ${name}`);
}

let visitedNames = new Set();

function nameToFilePath(name) {
  if (name.startsWith("ext:")) {
    const parts = name.split("/");
    const path = parts.slice(1).join("/");
    if (!visitedNames.has(path)) {
      visitedNames.add(path);
      return path;
    } else {
      return `${parts[1]}/${parts[2]}`;
    }
  }
  return name;
}

const groupByPercentTTD = {};

const groups = new Set(
  scripts.filter((n) => n.name !== "Unknown").map((script) => {
    const group = nameToGroup(script.name);
    groupByPercentTTD[group] ??= 0;
    groupByPercentTTD[group] += script.time / totalScriptTime * 100;
    return group;
  }),
);

function generateScriptsChartData() {
  return [
    ["root", null, 0],
    ...Array.from(groups).map((group) => {
      return [group, "root", 0];
    }),
    ...scripts.filter((n) => n.name !== "Unknown").map((script) => {
      return [
        nameToFilePath(script.name),
        nameToGroup(script.name),
        script.time,
      ];
    }),
  ];
}

const compressedRoot = cjson.compress.toString(root);

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
  <script type="text/javascript" src="https://www.gstatic.com/charts/loader.js"></script>

  <style>${Deno.readTextFileSync("style.css")}</style>
</head>
<body>
  <div class="column left maxw50">
 <div class="row top">
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
  <hr>
  <div class="row bottom" id="chart_div">
    Loading...
  </div>
   </div>
   <div class="resize" id="resize"></div>
  <div class="column right">
  <input type="text" id="search" placeholder="Filter"></input>
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
<script type="module">
import compressedJson from 'https://cdn.jsdelivr.net/npm/compressed-json@1.0.16/+esm';

const search = document.querySelector("#search");
var resize = document.querySelector("#resize");
var left = document.querySelector(".left");
var moveX =
   left.getBoundingClientRect().width +
   resize.getBoundingClientRect().width / 2;

var drag = false;
resize.addEventListener("mousedown", function (e) {
   drag = true;
   moveX = e.x;
});

document.addEventListener("mousemove", function (e) {
   moveX = e.x;
   if (drag) {
      left.style.width =
         moveX - resize.getBoundingClientRect().width / 2 + "px";
      e.preventDefault();
      drawChart();
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
window.showScriptObjects = showScriptObjects;

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

google.charts.load('current', {'packages':['treemap']});
google.charts.setOnLoadCallback(drawChart);

 function drawChart() {
    var data = google.visualization.arrayToDataTable(JSON.parse(${
  JSON.stringify(JSON.stringify(generateScriptsChartData()))
}), true);

    var options = {
      width: 'auto',
      height: 'auto',
        enableHighlight: true,
        maxDepth: 1,
        maxPostDepth: 2,
        minHighlightColor: '#8c6bb1',
        midHighlightColor: '#9ebcda',
        maxHighlightColor: '#edf8fb',
        minColor: '#009688',
        midColor: '#f7f7f7',
        maxColor: '#ee8100',
        headerHeight: 15,
        useWeightedAverageForAggregation: true,
        // Use click to highlight and double-click to drill down.
        eventsConfig: {
          highlight: ['click'],
          unhighlight: ['mouseout'],
          rollup: ['contextmenu'],
          drilldown: ['dblclick'],
        },
	generateTooltip: showStaticTooltip
    };

  const percentTTD = ${JSON.stringify(groupByPercentTTD)};

  function showStaticTooltip(row, size, value) {
  	const percent = percentTTD[data.getValue(row, 0)]?.toFixed(3);
	if (!percent) return "";
	return '<div style="background:#fd9; padding:10px; border-style:solid">' +
		'<span>' + data.getValue(row, 0) + '</span>' +
		'<span> ' + percent + '%</span><br>' +
		'</div>';
  }

    var chart = new google.visualization.TreeMap(document.getElementById('chart_div'));

    chart.draw(data, options);
  }
  
  window.drawChart = drawChart;

  // Redraw chart on resize
  window.addEventListener('resize', drawChart);

const data = compressedJson.decompress.fromString(${
  JSON.stringify(compressedRoot)
});

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
    if (!row) {
      return row;
    }

    tmpDiv.innerHTML = row;

    const contentEl = tmpDiv.querySelector('.infinite-tree-title')
    contentEl.innerHTML = node.name;

    const nodeEl = tmpDiv.querySelector('.infinite-tree-item');
    nodeEl.id = node.objId;
    nodeEl.setAttribute('data-id', node.id);

    return tmpDiv.innerHTML;
  }
});

let unfiltered = true;
search.addEventListener('keyup', (e) => {
  const keyword = e.target.value;
  if (keyword && e.key === "Enter") {
    unfiltered = false;
    tree.filter(keyword);
  } else if (!keyword && !unfiltered) {
    tree.unfilter();
    unfiltered = true;
  }
});
</script>

</html>`;

await Deno.writeTextFile("trace.html", html);
console.log("HTML file generated: trace.html");
