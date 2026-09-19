const state = { courses: new Map(), filtered: [], selected: null, history: [], cameFrom: null, taken: new Set(), departments: new Set() };
const palette = ["#3276b1", "#d65a4a", "#6d5bb5", "#2b9a85", "#c98a28", "#b44d88", "#4c7a45"];
let departmentColors = new Map();

const $ = (id) => document.getElementById(id);

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (ch === '"' && quoted && next === '"') { cell += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell); if (row.some((v) => v.trim())) rows.push(row);
      row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift().map((h) => h.trim());
  return rows.map((values) => Object.fromEntries(headers.map((h, i) => [h, (values[i] || "").trim()])));
}

function splitTopLevel(text, separator) {
  const parts = []; let start = 0, depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")") depth--;
    if (depth === 0 && text.slice(i, i + separator.length) === separator) {
      parts.push(text.slice(start, i).trim()); start = i + separator.length; i += separator.length - 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function parsePrerequisites(text) {
  if (!text || text.toLowerCase() === "none") return null;
  const groups = splitTopLevel(text, ",").map((group) => {
    const clean = group.replace(/^\(|\)$/g, "").trim();
    const alternatives = splitTopLevel(clean, " or ").map((alternative) => {
      const required = splitTopLevel(alternative.replace(/^\(|\)$/g, "").trim(), " and ");
      return required.length > 1 ? { type: "and", children: required.map((item) => ({ type: "course", code: item.trim() })) } : { type: "course", code: required[0].trim() };
    });
    return alternatives.length > 1 ? { type: "or", children: alternatives } : alternatives[0];
  });
  return groups.length > 1 ? { type: "and", children: groups } : groups[0];
}

function courseCode(dept, number) { return `${dept} ${number}`; }
function colorFor(dept) { return departmentColors.get(dept) || "#64748b"; }
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}
function resolveCourse(code) {
  const direct = state.courses.get(code);
  if (direct) return direct;
  const match = code.match(/^([A-Z]+)\s+([0-9].*)$/);
  if (!match) return undefined;
  const normalized = match[2].replace(/^0+(?=\d)/, "");
  return [...state.courses.values()].find((course) => course.department === match[1] && course["class number"].replace(/^0+(?=\d)/, "") === normalized);
}

function flattenCodes(node) {
  if (!node) return [];
  if (node.type === "course") return [node.code];
  return node.children.flatMap(flattenCodes);
}

function courseCard(course, code = course?.code, extraClass = "") {
  if (!course) return `<span class="node-card relation-card unknown"><span class="node-label">${code}</span><span class="node-name">Course details unavailable in this dataset</span></span>`;
  const highlight = course.code === state.cameFrom ? " came-from" : "";
  const complete = state.taken.has(course.code) ? " complete" : "";
  return `<button class="node-card node-button relation-card${highlight}${complete} ${extraClass}" data-focus-code="${course.code}" style="--dept-color:${colorFor(course.department)}"><span class="node-label">${course.code}${complete ? '<span class="complete-mark" aria-label="Completed">✓</span>' : ""}</span><span class="node-name">${course.name}</span></button>`;
}

function requirementOptions(node) {
  if (!node) return "";
  if (node.type === "course") return courseCard(resolveCourse(node.code), node.code);
  if (node.type === "and") return node.children.map(requirementOptions).join("");
  if (node.type === "or") {
    const options = node.children.flatMap((child) => child.type === "and" ? child.children : [child]);
    const complete = options.some((option) => {
      const course = option.type === "course" ? resolveCourse(option.code) : null;
      return course && state.taken.has(course.code);
    });
    return `<div class="choice-group${complete ? " choice-complete" : ""}"><div class="choice-heading"><span class="choice-badge">${complete ? "✓" : "OR"}</span><span><strong>${complete ? "COMPLETE" : "TAKE ONE OF THESE"}</strong><small>${complete ? "A completed course satisfies this prerequisite" : "Any one option satisfies this prerequisite"}</small></span></div><div class="choice-options">${options.map((option) => requirementOptions(option)).join("")}</div></div>`;
  }
  return "";
}

function renderFocusView(course) {
  const prerequisiteCodes = flattenCodes(course.prerequisites);
  const dependents = [...state.courses.values()].filter((candidate) => flattenCodes(candidate.prerequisites).some((code) => resolveCourse(code)?.code === course.code));
  const prerequisiteMarkup = prerequisiteCodes.length
    ? `<div class="relation-line"></div><div class="relation-title">DIRECT PREREQUISITES <span>· click a class to explore it</span></div><div class="requirement-list">${requirementOptions(course.prerequisites)}</div>`
    : '<p class="no-prerequisites">No prerequisites listed for this class.</p>';
  const dependentMarkup = dependents.length
    ? `<div class="relation"><div class="relation-title"><span>COURSES THAT REQUIRE THIS CLASS</span> · click to climb upward</div><div class="relation-cards">${dependents.map((item) => courseCard(item)).join("")}</div><div class="relation-line"></div></div>`
    : "";
  return `${dependentMarkup}<p class="focus-label">FOCUSED CLASS</p><button class="node-card node-button focus-card" style="--dept-color:${colorFor(course.department)}" data-focus-code="${course.code}"><span class="node-label">${course.code}</span><span class="node-name">${course.name}</span></button><div class="relation">${prerequisiteMarkup}</div>`;
}

function renderClassDetails(course) {
  const fields = [
    ["Department", course.department],
    ["Class number", course["class number"]],
    ["Catalog code", course["dept and classnumber combined"]],
    ["Course name", course["course name"]],
    ["Description", course.description],
    ["Prerequisites", course["prerequisites classes"]]
  ];
  return `<h3>Class details</h3><dl>${fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "None")}</dd></div>`).join("")}</dl>`;
}

function requirementSatisfied(node) {
  if (!node) return true;
  if (node.type === "course") {
    const course = resolveCourse(node.code);
    return Boolean(course && state.taken.has(course.code));
  }
  if (node.type === "and") return node.children.every(requirementSatisfied);
  if (node.type === "or") return node.children.some(requirementSatisfied);
  return false;
}

function requirementGroups(course) {
  if (!course.prerequisites) return [];
  return course.prerequisites.type === "and" ? course.prerequisites.children : [course.prerequisites];
}

function prerequisiteBadge(course, code) {
    const prerequisite = resolveCourse(code);
    const department = prerequisite?.department;
    const label = prerequisite ? `${prerequisite.code} · ${prerequisite.name}` : `${code} · Course details unavailable in this dataset`;
    return `<span class="prereq-badge" style="--dept-color:${colorFor(department)}" title="${escapeHtml(label)}" aria-label="Needed: ${escapeHtml(label)}">${escapeHtml(prerequisite?.code || code)}</span>`;
}

function prerequisiteBadgesNode(node) {
  if (!node) return "";
  if (node.type === "course") {
    const prerequisite = resolveCourse(node.code);
    return prerequisite && state.taken.has(prerequisite.code) ? "" : prerequisiteBadge(null, node.code);
  }
  if (node.type === "and") return node.children.map(prerequisiteBadgesNode).join("");
  if (node.type === "or") {
    if (requirementSatisfied(node)) return "";
    const options = node.children.flatMap((child) => child.type === "and" ? child.children : [child]);
    const departments = options.map((option) => resolveCourse(option.code)?.department).filter(Boolean);
    const borderColors = [...new Set(departments)].map((department) => colorFor(department));
    return `<span class="prereq-split" style="--split-gradient:${borderColors.join(",")}" title="Complete any one of these prerequisites">${options.map((option) => {
      const code = option.code;
      const prerequisite = resolveCourse(code);
      return `<span style="--dept-color:${colorFor(prerequisite?.department)}">${escapeHtml(prerequisite?.code || code)}</span>`;
    }).join("")}</span>`;
  }
  return "";
}

function prerequisiteBadges(course) {
  return requirementGroups(course).map((group) => {
    const content = prerequisiteBadgesNode(group);
    return content ? `<span class="prereq-group">${content}</span>` : "";
  }).join("");
}

function progressCard(course, detail) {
  const ready = detail === "All prerequisites complete";
  const badges = ready || detail === "Completed" ? "" : prerequisiteBadges(course);
  return `<button class="progress-card node-button ${ready ? "progress-ready" : ""}" data-progress-code="${course.code}" style="--dept-color:${colorFor(course.department)}">${ready ? '<span class="ready-tag" aria-label="All prerequisites complete"></span>' : ""}<span class="progress-code">${course.code}</span><span class="progress-name">${course.name}</span>${badges ? `<span class="progress-badges">${badges}</span>` : ""}${detail ? `<span class="progress-detail">${detail}</span>` : ""}</button>`;
}

function renderProgress() {
  const visibleCourses = [...state.courses.values()].filter((course) => state.departments.has(course.department));
  const completed = visibleCourses.filter((course) => state.taken.has(course.code));
  const eligible = visibleCourses.filter((course) => !state.taken.has(course.code) && course.prerequisites && requirementSatisfied(course.prerequisites));
  const almostReady = visibleCourses.map((course) => {
    const missing = requirementGroups(course).filter((group) => !requirementSatisfied(group)).length;
    return { course, missing };
  }).filter(({ course, missing }) => !state.taken.has(course.code) && course.prerequisites && missing > 0 && missing <= 2);
  const departments = [...departmentColors.keys()].filter((dept) => state.departments.has(dept));
  const toc = `<a class="progress-toc-link ready-link" href="#progress-ready">READY</a>${departments.map((dept) => `<a class="progress-toc-link" href="#progress-${dept}" style="--dept-color:${colorFor(dept)}">${dept}</a>`).join("")}`;
  const sections = departments.map((dept) => {
    const courses = [...new Map([
      ...eligible.filter((course) => course.department === dept).map((course) => [course.code, progressCard(course, "All prerequisites complete")]),
      ...almostReady.filter(({ course }) => course.department === dept).map(({ course }) => [course.code, progressCard(course, "")])
    ]).values()];
    return `<section id="progress-${dept}" class="progress-department"><h3 style="--dept-color:${colorFor(dept)}"><span class="dept-dot"></span>${dept}<span>${courses.length}</span></h3><div class="progress-grid">${courses.length ? courses.join("") : '<p class="progress-empty">No matching classes in this department.</p>'}</div></section>`;
  }).join("");
  const completedSection = `<section id="progress-completed" class="progress-completed"><h3>Completed courses <span>${completed.length}</span></h3><div class="progress-grid">${completed.length ? completed.map((course) => progressCard(course, "Completed")).join("") : '<p class="progress-empty">Add courses above to start tracking your progress.</p>'}</div></section>`;
  const readySection = `<section id="progress-ready" class="progress-department progress-ready-section"><h3><span class="dept-dot ready-dot"></span>READY TO ENROLL <span>${eligible.length}</span></h3><div class="progress-grid">${eligible.length ? eligible.map((course) => progressCard(course, "All prerequisites complete")).join("") : '<p class="progress-empty">No additional classes are fully unlocked yet.</p>'}</div></section>`;
  $("progress-content").innerHTML = `<div class="progress-header"><div><p class="eyebrow">YOUR COURSE PLAN</p><h2>My progress</h2><p>See what you have completed and what you are closest to being ready for.</p></div><span class="progress-count">${completed.length} completed</span></div><div class="progress-layout"><nav class="progress-toc" aria-label="Jump to progress section">${toc}</nav><div class="progress-main">${completedSection}${readySection}${sections || '<p class="progress-empty">Select a department to see progress.</p>'}</div></div>`;
  document.querySelectorAll("[data-progress-code]").forEach((button) => button.addEventListener("click", () => {
    switchTab("explore");
    selectCourse(button.dataset.progressCode, true);
  }));
}

function switchTab(tab) {
  const explore = tab === "explore";
  $("explore-tab").classList.toggle("active", explore);
  $("progress-tab").classList.toggle("active", !explore);
  $("workspace").hidden = !explore;
  $("progress-content").hidden = explore;
  if (!explore) renderProgress();
}

function toggleTakenPanel() {
  const isOpen = $("taken-toggle").getAttribute("aria-expanded") === "true";
  $("taken-toggle").setAttribute("aria-expanded", String(!isOpen));
  $("taken-panel").hidden = isOpen;
  $("taken-toggle-icon").textContent = isOpen ? "⌄" : "⌃";
}

function renderTakenOptions(query = "") {
  const matches = [...state.courses.values()].filter((course) => !state.taken.has(course.code) && `${course.code} ${course.name}`.toLowerCase().includes(query.toLowerCase().trim())).slice(0, 12);
  $("taken-options").innerHTML = matches.map((course) => `<button type="button" data-taken-code="${course.code}"><strong>${course.code}</strong><span>${course.name}</span></button>`).join("");
  $("taken-options").hidden = !query || matches.length === 0;
  document.querySelectorAll("[data-taken-code]").forEach((button) => button.addEventListener("click", () => {
    state.taken.add(button.dataset.takenCode);
    $("taken-search").value = "";
    renderTakenOptions();
    renderTakenList();
    if (state.selected) selectCourse(state.selected.code, true);
    if (!$("progress-content").hidden) renderProgress();
  }));
}

function renderTakenList() {
  $("taken-list").innerHTML = [...state.taken].map((code) => {
    const course = state.courses.get(code);
    return `<button type="button" class="taken-chip" data-remove-taken="${code}" style="--dept-color:${colorFor(course?.department)}">${code}<span aria-hidden="true">×</span></button>`;
  }).join("");
  document.querySelectorAll("[data-remove-taken]").forEach((button) => button.addEventListener("click", () => {
    state.taken.delete(button.dataset.removeTaken);
    renderTakenList();
    if (state.selected) selectCourse(state.selected.code, true);
    if (!$("progress-content").hidden) renderProgress();
  }));
}

function renderDepartmentFilters() {
  $("department-filters").innerHTML = `<span class="filter-label">Departments</span>${[...departmentColors].map(([dept, color]) => `<label class="department-filter" style="--dept-color:${color}"><input type="checkbox" data-department="${dept}" ${state.departments.has(dept) ? "checked" : ""}><span>${dept}</span></label>`).join("")}`;
  document.querySelectorAll("[data-department]").forEach((checkbox) => checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.departments.add(checkbox.dataset.department);
    else state.departments.delete(checkbox.dataset.department);
    applyClassFilter();
    if (!$("progress-content").hidden) renderProgress();
  }));
}

function applyClassFilter() {
  const query = $("class-search").value.toLowerCase().trim();
  state.filtered = [...state.courses.values()].filter((course) => state.departments.has(course.department) && `${course.code} ${course.name}`.toLowerCase().includes(query));
  renderList();
}

function renderList() {
  $("course-count").textContent = `${state.filtered.length} of ${state.courses.size}`;
  $("course-options").innerHTML = state.filtered.map((course) => `<button class="course-button ${state.selected?.code === course.code ? "active" : ""}" data-code="${course.code}"><span class="course-code">${course.code}</span><span class="course-name">${course.name}</span></button>`).join("");
  document.querySelectorAll(".course-button").forEach((button) => button.addEventListener("click", () => selectCourse(button.dataset.code)));
}

function selectCourse(code, fromHistory = false) {
  const course = state.courses.get(code); if (!course) return;
  if (!fromHistory && state.selected && state.selected.code !== course.code) {
    state.history.push(state.selected.code);
    state.cameFrom = state.selected.code;
  } else if (fromHistory) {
    state.cameFrom = state.history[state.history.length - 1] || null;
  }
  state.selected = course; $("map-content").hidden = false;
  $("back-button").hidden = state.history.length === 0;
  $("selected-title").textContent = `${course.code} · ${course.name}`;
  $("selected-description").textContent = course.description;
  $("selected-department").textContent = course.department;
  $("selected-department").style.setProperty("--dept-color", colorFor(course.department));
  $("tree").innerHTML = renderFocusView(course);
  $("class-details").innerHTML = renderClassDetails(course);
  document.querySelectorAll("[data-focus-code]").forEach((button) => button.addEventListener("click", () => selectCourse(button.dataset.focusCode)));
  renderList();
}

$("back-button").addEventListener("click", () => {
  const previousCode = state.history.pop();
  if (previousCode) selectCourse(previousCode, true);
});

function setup(data) {
  state.courses.clear();
  state.history = [];
  state.cameFrom = null;
  state.taken.clear();
  data.forEach((row) => {
    const code = courseCode(row.department, row["class number"]);
    state.courses.set(code, { ...row, code, name: row["course name"], prerequisites: parsePrerequisites(row["prerequisites classes"]) });
  });
  [...new Set(data.map((row) => row.department))].forEach((dept, i) => departmentColors.set(dept, palette[i % palette.length]));
  state.departments = new Set(departmentColors.keys());
  renderDepartmentFilters();
  state.filtered = [...state.courses.values()];
  renderTakenOptions();
  renderTakenList();
  renderList();
  if (state.courses.size) selectCourse([...state.courses.keys()][0]);
}

function loadText(text) {
  try { setup(parseCsv(text)); $("status").textContent = ""; }
  catch (error) { $("status").textContent = `Could not read the CSV: ${error.message}`; }
}

$("class-search").addEventListener("input", (event) => {
  applyClassFilter();
});
$("taken-search").addEventListener("input", (event) => renderTakenOptions(event.target.value));
$("taken-toggle").addEventListener("click", toggleTakenPanel);
$("explore-tab").addEventListener("click", () => switchTab("explore"));
$("progress-tab").addEventListener("click", () => switchTab("progress"));
$("csv-file").addEventListener("change", (event) => {
  const file = event.target.files[0]; if (file) file.text().then(loadText);
});
fetch("classes.csv").then((response) => {
  if (!response.ok) throw new Error("classes.csv was not found");
  return response.text();
}).then(loadText).catch(() => {
  $("status").textContent = "Choose classes.csv above when opening this page directly from your computer.";
});
