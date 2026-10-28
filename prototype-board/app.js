// PROTOTYPE (throwaway, branch prototype/board): client for the read-only Ark board. Vanilla JS, no build.
// Polls /api/board every 2s; each render is a full HTML string morphed into the live DOM, so only changed nodes animate.
// Variants (?variant=A|B|C): A Queue (what to start next), B Lanes (dependency flow), C Run page (one run in depth).

const POLL_MS = 2000;
const START_COMMAND = (ticketId) => `ark launch --model anthropic/claude-opus-5-5 --thinking high\n/skill:ark ticket ${ticketId}`;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// ---------- state ----------

const params = new URLSearchParams(location.search);
const state = {
	data: null,
	error: false,
	fetchedAt: "",
	variant: ["A", "B", "C"].includes((params.get("variant") ?? "").toUpperCase()) ? params.get("variant").toUpperCase() : "A",
	theme: params.get("theme") ?? "auto",
	project: params.get("project") ?? "",
	selectedRun: params.get("run") ?? "",
	selectedTicket: params.get("ticket") ?? "",
	filter: params.get("filter") ?? "all",
	open: new Set(),
	showDone: false,
	hover: "",
	copied: "",
	quiet: true, // no change animation on first paint or variant switch
};

// ---------- small helpers ----------

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function ago(iso) {
	if (!iso || Number.isNaN(Date.parse(iso))) return "–";
	const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	if (seconds < 60) return `${Math.floor(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : "");
const humanize = (name) => name.replace(/[._]/g, " ");
const timeTag = (iso) => `<time data-t="${escapeHtml(iso)}">${ago(iso)}</time>`;
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const project = () => state.data.projects.find((candidate) => candidate.name === state.project) ?? state.data.projects[0];
const ticketById = (id) => project().tickets.find((ticket) => ticket.id === id);
const runById = (id) => project().runs.find((run) => run.id === id);
const byDepth = (a, b) => a.layer - b.layer || a.id.localeCompare(b.id);

// A ticket with an active run is "running" even if its file status or dependencies disagree.
function laneOf(ticket) {
	if (ticket.status === "done") return "done";
	if (ticket.activeRun || ticket.status === "in_progress") return "running";
	return ticket.readiness === "ready" ? "ready" : "blocked";
}

function runTone(run) {
	if (run.state.startsWith("awaiting_")) return "wait";
	if (run.status === "done") return "ok";
	return run.status === "active" ? "run" : "bad";
}

const pill = (tone, text) => `<span class="pill ${tone}"><span>${escapeHtml(text)}</span></span>`;
const statePill = (run) => pill(runTone(run), run.state ? humanize(run.state) : run.status);
const verdictTone = (verdict) => (/pass|proven/.test(verdict) ? "ok" : /fail/.test(verdict) ? "bad" : "muted");
const actor = (agent) => (/human|user|you/.test(agent) ? "you" : agent);

// ---------- shared fragments ----------

function header() {
	const projectData = project();
	const counts = { ready: 0, running: 0, blocked: 0, done: 0 };
	for (const ticket of projectData.tickets) counts[laneOf(ticket)]++;
	const projectSwitch =
		state.data.projects.length > 1
			? `<div class="seg" role="group" aria-label="Project">${state.data.projects.map((candidate) => `<button data-project="${candidate.name}" aria-pressed="${candidate.name === projectData.name}">${escapeHtml(candidate.name)}</button>`).join("")}</div>`
			: `<span class="project mono">${escapeHtml(projectData.name)}</span>`;
	return `<header class="top" data-k="top">
		<div class="top-id"><h1>Ark board</h1><span class="note">Prototype. Read-only view of the files in ~/.ark.</span></div>
		${projectSwitch}
		<p class="summary" aria-label="Ticket counts">${["running", "ready", "blocked", "done"].map((lane) => `<span class="count-${lane}"><span class="swatch"></span><span>${counts[lane]} ${lane}</span></span>`).join("")}</p>
		<p class="live ${state.error ? "bad" : ""}"><span class="swatch"></span><span>${state.error ? "Disconnected, retrying" : "Polled"}</span>${state.error ? "" : `<time class="ago" data-t="${state.fetchedAt}">${ago(state.fetchedAt)}</time>`}</p>
	</header>`;
}

function needsStrip(runs) {
	const waiting = runs.filter((run) => run.needsYou);
	const items = waiting
		.map(
			(run) => `<li class="need" data-k="n:${run.id}">
				<span class="need-mark">${icon("clock")}</span>
				<button class="id link" data-run="${run.id}">${run.ticket}</button>
				<span class="need-what">${escapeHtml(run.needsYou)}${run.needsKind === "gate" ? " is waiting for your answer" : ""}</span>
				<span class="need-since"><span>${run.needsKind === "session" ? "idle for" : "since"}</span>${timeTag(run.waitingSince)}${run.needsKind === "session" ? "" : "<span>ago</span>"}</span>
				<span class="need-how">${run.needsKind === "gate" ? "Answer in the Oh My Pi session." : run.needsKind === "session" ? "Reply in its Oh My Pi session." : "Check the run."}</span>
				${run.needsText ? `<span class="need-text" data-k="text">${escapeHtml(run.needsText)}</span>` : ""}
			</li>`,
		)
		.join("");
	return `<section class="needs ${waiting.length ? "has" : ""}" data-k="needs" aria-label="Needs you">
		<h2>Needs you <span class="count">${waiting.length}</span></h2>
		${waiting.length ? `<ul>${items}</ul>` : `<p class="quiet">${icon("check")}<span>Nothing is waiting on you. ${runs.filter((run) => run.status === "active").length} run(s) active.</span></p>`}
	</section>`;
}

function copyButton(ticket, compact = false) {
	const copied = state.copied === ticket.id;
	return `<button class="copy ${copied ? "done" : ""}" data-copy="${ticket.id}" title="Copies two lines: ark launch --model anthropic/claude-opus-5-5 --thinking high, then /skill:ark ticket ${ticket.id}" aria-label="Copy start command for ${ticket.id}">${icon(copied ? "check" : "copy")}<span>${copied ? "Copied" : compact ? "Copy" : "Copy start command"}</span></button>`;
}

function runChips(ticket) {
	return ticket.runs
		.map((id) => runById(id))
		.filter(Boolean)
		.map((run) => `<button class="chip of-run ${runTone(run)}" data-run="${run.id}" aria-label="Show run ${run.id}"><span>run ${run.id.split("-").pop()}</span><span>${escapeHtml(humanize(run.state))}</span></button>`)
		.join("");
}

function dependencyChips(ticket) {
	return ticket.waitingOn
		.map((id) => {
			const dependency = ticketById(id);
			return `<button class="chip dep ${dependency ? laneOf(dependency) : ""}" data-ticket="${id}"><span>${id}</span><span>${dependency ? laneOf(dependency) : "missing"}</span></button>`;
		})
		.join("");
}

function criteriaList(ticket) {
	return `<ul class="criteria" data-k="criteria">${ticket.criteria.map((criterion) => `<li data-k="c:${criterion.id}"><span class="id">${criterion.id.replace(ticket.id + "-", "")}</span><span class="criterion-text">${escapeHtml(criterion.text)}</span></li>`).join("")}</ul>`;
}

function gateChips(run, detailed) {
	return `<ol class="gates ${detailed ? "steps" : ""}" aria-label="Gates">${run.gates
		.map((gate) => {
			const tone = gate.waiting ? "wait" : gate.answer ? "ok" : "idle";
			const note = gate.waiting ? "awaiting you" : gate.answer ? `${gate.answer}${detailed ? ` · ${gate.by.replace(/\s*\(.*\)/, "")} · ${clock(gate.at)}` : ""}` : "not reached";
			return `<li class="gate ${tone}" data-k="g:${gate.name}" title="${escapeHtml(gate.by)}"><span class="gate-mark">${icon(gate.waiting ? "clock" : gate.answer ? "check" : "dot")}</span><span class="gate-name">${gate.name}</span><span class="gate-note">${escapeHtml(note)}</span></li>`;
		})
		.join("")}</ol>`;
}

function sessionLine(run) {
	if (!run.session) return `<p class="session" data-k="session"><span class="note">No main session bound.</span></p>`;
	const { model, tool, toolIntent, toolRunning } = run.session;
	return `<p class="session" data-k="session"><span class="model mono">${escapeHtml(model)}</span><span class="tool ${toolRunning ? "live" : ""}"><span class="tool-name mono">${escapeHtml(tool || "no tool")}</span><span class="tool-state">${toolRunning ? "running" : "last"}</span></span><span class="intent">${escapeHtml(toolIntent)}</span></p>`;
}

function timeline(run, limit = 8) {
	return `<ol class="tl" aria-label="Last ledger events">${run.ledger
		.slice(0, limit)
		.map((event) => `<li data-k="e:${event.seq}"><span class="tl-time mono">${clock(event.ts)}</span><span class="tl-type mono">${escapeHtml(event.type)}</span><span class="tl-sum">${escapeHtml(event.summary)}</span></li>`)
		.join("")}</ol>`;
}

function facts(run) {
	const next = `<span class="actor ${actor(run.nextAction.agent) === "you" ? "you" : ""}">${escapeHtml(actor(run.nextAction.agent) || "none")}</span><span>${escapeHtml(humanize(run.nextAction.kind) || "–")}</span>`;
	return `<dl class="facts">
		<div class="fact" data-k="f:next"><dt>Next</dt><dd class="next">${next}</dd></div>
		<div class="fact" data-k="f:round"><dt>Round</dt><dd>${run.round}</dd></div>
		<div class="fact" data-k="f:age"><dt>Age</dt><dd>${timeTag(run.startedAt)}</dd></div>
		<div class="fact" data-k="f:upd"><dt>Last event</dt><dd class="ago">${timeTag(run.updatedAt)}</dd></div>
	</dl>`;
}

function runCard(run) {
	const ticket = ticketById(run.ticket);
	return `<article class="run-card ${run.needsYou ? "needs" : ""} ${state.selectedRun === run.id ? "picked" : ""}" data-k="run:${run.id}">
		<header class="run-head"><button class="id link" data-ticket="${run.ticket}">${run.ticket}</button><span class="run-title">${escapeHtml(ticket?.title ?? "")}</span>${statePill(run)}</header>
		${facts(run)}
		${gateChips(run, false)}
		${sessionLine(run)}
		${timeline(run)}
	</article>`;
}

const emptyNote = (text) => `<p class="empty" data-k="empty">${escapeHtml(text)}</p>`;

// ---------- Variant A: Queue ----------

const LANES = [
	["ready", "Ready to start", "status ready and every dependency done"],
	["running", "Running", "has an active run, or status in_progress"],
	["blocked", "Blocked", "waiting on unfinished tickets"],
	["done", "Done", ""],
];

function ticketRow(ticket) {
	const lane = laneOf(ticket);
	const open = state.open.has(`t:${ticket.id}`);
	const waits = ticket.waitingOn.length && lane !== "done" ? `<span class="waits" data-k="waits"><span class="waits-label">${icon("lock")}<span>waits on</span></span>${dependencyChips(ticket)}</span>` : "";
	return `<article class="row ${lane} ${state.selectedTicket === ticket.id ? "picked" : ""}" data-k="t:${ticket.id}">
		<div class="row-head">
			<button class="row-main" data-open="t:${ticket.id}" aria-expanded="${open}"><span class="id">${ticket.id}</span><span class="row-title">${escapeHtml(ticket.title)}</span></button>
			${waits}<span class="row-meta"><span class="ms mono">${escapeHtml(ticket.milestone)}</span>${runChips(ticket)}${lane === "ready" ? copyButton(ticket) : ""}</span>
		</div>
		${open ? criteriaList(ticket) : ""}
	</article>`;
}

function renderQueue() {
	const projectData = project();
	const lanes = Object.fromEntries(LANES.map(([name]) => [name, projectData.tickets.filter((ticket) => laneOf(ticket) === name).sort(byDepth)]));
	const backlog = LANES.filter(([name]) => lanes[name].length)
		.map(([name, title, hint]) => {
			const collapsed = name === "done" && !state.showDone;
			return `<section class="lane ${name}" data-k="lane:${name}">
				<header class="lane-head">${name === "done" ? `<button class="lane-toggle" data-show-done aria-expanded="${!collapsed}">${icon(collapsed ? "chevron-right" : "chevron-down")}<h2>${title}</h2></button>` : `<h2>${title}</h2>`}<span class="count">${lanes[name].length}</span><span class="hint">${hint}</span></header>
				${collapsed ? "" : `<div class="rows" data-k="rows">${lanes[name].map(ticketRow).join("")}</div>`}
			</section>`;
		})
		.join("");
	return `<div class="A" data-k="view-A">
		${header()}
		${needsStrip(projectData.runs)}
		<div class="A-body">
			<main class="A-backlog" aria-label="Backlog">${backlog}</main>
			<aside class="A-runs" aria-label="Runs"><h2>Runs <span class="count">${projectData.runs.length}</span></h2><div class="stack">${projectData.runs.map(runCard).join("") || emptyNote("No runs yet.")}</div></aside>
		</div>
	</div>`;
}

// ---------- Variant B: Lanes (dependency flow) ----------

function chainOf(id) {
	const chain = new Set([id]);
	const up = (ticketId) => ticketById(ticketId)?.dependsOn.forEach((dependency) => !chain.has(dependency) && (chain.add(dependency), up(dependency)));
	const down = (ticketId) => ticketById(ticketId)?.unlocks.forEach((unlocked) => !chain.has(unlocked) && (chain.add(unlocked), down(unlocked)));
	up(id);
	down(id);
	return chain;
}

function renderLanes() {
	const projectData = project();
	const chain = state.hover ? chainOf(state.hover) : null;
	const mark = (id) => (chain ? (chain.has(id) ? "hl" : "dim") : "");
	const done = projectData.tickets.filter((ticket) => ticket.status === "done").sort(byDepth);
	const open = projectData.tickets.filter((ticket) => ticket.status !== "done");
	const depths = [...new Set(open.map((ticket) => ticket.layer))].sort((a, b) => a - b);
	const tile = (ticket) => {
		const lane = laneOf(ticket);
		const footer = lane === "ready" ? copyButton(ticket) : lane === "blocked" ? `<span class="tile-wait">${icon("lock")}<span>${ticket.waitingOn.map((id) => id.replace("ARK-", "")).join(", ")}</span></span>` : lane === "running" ? `<span class="tile-run">${ticket.activeRun ? escapeHtml(humanize(runById(ticket.activeRun).state)) : "in progress"}</span>` : "";
		return `<div class="tile ${lane} ${mark(ticket.id)} ${state.selectedTicket === ticket.id ? "picked" : ""}" data-k="t:${ticket.id}" data-tile="${ticket.id}" tabindex="0" role="group" aria-label="${ticket.id} ${escapeHtml(ticket.title)}, ${lane}">
			<div class="tile-top"><span class="id">${ticket.id}</span><span class="ms mono">${escapeHtml(ticket.milestone)}</span></div>
			<div class="tile-title">${escapeHtml(ticket.title)}</div>
			<div class="tile-foot">${footer}</div>
		</div>`;
	};
	const chip = (ticket) => `<div class="mini ${mark(ticket.id)}" data-k="t:${ticket.id}" data-tile="${ticket.id}" tabindex="0" role="button" title="${escapeHtml(ticket.title)}"><span class="id">${ticket.id}</span></div>`;
	const columns = `<div class="col done" data-k="col:done"><h3>Done <span class="count">${done.length}</span></h3><div class="col-body">${done.map(chip).join("")}</div></div>${depths
		.map((depth) => `<div class="col" data-k="col:${depth}"><h3 title="Longest chain of tickets that must finish before these">Depth ${depth}</h3><div class="col-body">${open.filter((ticket) => ticket.layer === depth).sort(byDepth).map(tile).join("")}</div></div>`)
		.join("")}`;
	const selected = ticketById(state.selectedTicket) ?? open.find((ticket) => ticket.activeRun) ?? open.find((ticket) => laneOf(ticket) === "running") ?? open.find((ticket) => laneOf(ticket) === "ready") ?? open[0];
	return `<div class="B" data-k="view-B">
		${header()}
		${needsStrip(projectData.runs)}
		<section class="B-graph" aria-label="Dependency lanes"><div class="B-cols" data-k="cols">${columns}<svg class="B-edges" data-skip="" data-k="edges" aria-hidden="true"></svg></div></section>
		${selected ? ticketDetail(selected) : ""}
		<section class="B-runs" aria-label="Runs"><h2>Runs <span class="count">${projectData.runs.length}</span></h2><div class="dock">${projectData.runs.map(runCard).join("") || emptyNote("No runs yet.")}</div></section>
	</div>`;
}

function ticketDetail(ticket) {
	const lane = laneOf(ticket);
	const unlocks = ticket.unlocks.map((id) => `<button class="chip dep" data-ticket="${id}"><span>${id}</span></button>`).join("") || `<span class="note">nothing</span>`;
	return `<section class="detail ${lane}" data-k="detail" aria-label="Selected ticket">
		<div class="detail-main">
			<header><span class="id">${ticket.id}</span><h2>${escapeHtml(ticket.title)}</h2>${pill(lane === "ready" ? "ok" : lane === "running" ? "run" : lane === "done" ? "muted" : "idle", lane)}</header>
			<div class="detail-links"><div class="waits"><span class="waits-label">${icon("lock")}<span>waits on</span></span>${ticket.waitingOn.length ? dependencyChips(ticket) : `<span class="note">nothing</span>`}</div><div class="waits"><span class="waits-label"><span>unlocks</span></span>${unlocks}</div>${runChips(ticket) ? `<div class="waits"><span class="waits-label"><span>runs</span></span>${runChips(ticket)}</div>` : ""}</div>
			${lane === "ready" ? `<div class="command"><code>ark launch --model anthropic/claude-opus-5-5 --thinking high</code><code>/skill:ark ticket ${ticket.id}</code>${copyButton(ticket)}</div>` : ""}
		</div>
		${criteriaList(ticket)}
	</section>`;
}

// ---------- Variant C: Run page ----------

function renderRunPage() {
	const projectData = project();
	const run = runById(state.selectedRun) ?? projectData.runs.find((candidate) => candidate.needsYou) ?? projectData.runs.find((candidate) => candidate.status === "active") ?? projectData.runs[0];
	const filters = ["all", "ready", "running", "blocked", "done"];
	const shown = projectData.tickets.filter((ticket) => state.filter === "all" || laneOf(ticket) === state.filter).sort(byDepth);
	const rail = projectData.runs
		.map((candidate) => `<button class="rail-run ${candidate.id === run?.id ? "picked" : ""} ${candidate.needsYou ? "needs" : ""}" data-k="r:${candidate.id}" data-run="${candidate.id}" aria-pressed="${candidate.id === run?.id}"><span class="id">${candidate.ticket}</span>${statePill(candidate)}<span class="ago">${timeTag(candidate.startedAt)}</span></button>`)
		.join("");
	const backlog = shown
		.map((ticket) => {
			const lane = laneOf(ticket);
			const open = state.open.has(`t:${ticket.id}`);
			return `<li class="line ${lane}" data-k="t:${ticket.id}">
				<button class="line-main" data-open="t:${ticket.id}" aria-expanded="${open}"><span class="swatch"></span><span class="id">${ticket.id}</span><span class="line-title">${escapeHtml(ticket.title)}</span></button>
				<span class="line-side">${lane === "blocked" ? `<span class="line-wait">${ticket.waitingOn.map((id) => id.replace("ARK-", "")).join(", ")}</span>` : lane === "ready" ? copyButton(ticket, true) : ""}${runChips(ticket)}</span>
				${open ? `<div class="line-open" data-k="open">${ticket.waitingOn.length ? `<div class="waits"><span class="waits-label">${icon("lock")}<span>waits on</span></span>${dependencyChips(ticket)}</div>` : ""}${criteriaList(ticket)}</div>` : ""}
			</li>`;
		})
		.join("");
	return `<div class="C" data-k="view-C">
		${header()}
		${needsStrip(projectData.runs)}
		<div class="C-body">
			<nav class="C-rail" aria-label="Runs"><h2>Runs <span class="count">${projectData.runs.length}</span></h2><div class="rail-list">${rail || emptyNote("No runs yet.")}</div></nav>
			<main class="C-page" aria-label="Run page" data-k="page">${run ? runPage(run) : emptyNote("No runs to show.")}</main>
			<section class="C-backlog" aria-label="Backlog"><h2>Backlog <span class="count">${shown.length}</span></h2>
				<div class="seg" role="group" aria-label="Filter tickets">${filters.map((name) => `<button data-filter="${name}" aria-pressed="${state.filter === name}">${name}</button>`).join("")}</div>
				<ul class="lines">${backlog}</ul>
			</section>
		</div>
	</div>`;
}

function runPage(run) {
	const ticket = ticketById(run.ticket);
	const criteriaRows = Object.entries(run.criteria)
		.map(([id, verdict]) => `<li data-k="a:${id}"><span class="id">${id.replace(run.ticket + "-", "")}</span><span class="criterion-text">${escapeHtml(ticket?.criteria.find((criterion) => criterion.id === id)?.text ?? "")}</span><span class="pill ${verdictTone(verdict)}"><span>${escapeHtml(verdict)}</span></span></li>`)
		.join("");
	const findings = Object.entries(run.findings).map(([bucket, count]) => `<li data-k="b:${bucket}"><span>${humanize(bucket)}</span><span class="mono">${count}</span></li>`).join("");
	return `<article class="page ${run.needsYou ? "needs" : ""}" data-k="run:${run.id}">
		<header class="page-head">
			<div><button class="id link" data-ticket="${run.ticket}">${run.ticket}</button><h2>${escapeHtml(ticket?.title ?? run.ticket)}</h2><p class="note mono">${run.id} · ${run.playbook}</p></div>
			${statePill(run)}
		</header>
		${facts(run)}
		${gateChips(run, true)}
		<div class="page-grid">
			<section class="page-col"><h3>Timeline <span class="count">${run.ledger.length} of ${run.ledgerCount}</span></h3>${timeline(run)}</section>
			<section class="page-col">
				<h3>Orchestrator</h3>${sessionLine(run)}
				<h3>Acceptance criteria</h3><ul class="criteria wide" data-k="acs">${criteriaRows}</ul>
				${findings ? `<h3>Findings</h3><ul class="kv" data-k="findings">${findings}</ul>` : ""}
				<h3>Repos</h3><ul class="kv" data-k="repos">${run.repos.map((repo) => `<li data-k="p:${repo.name}"><span class="mono">${escapeHtml(repo.branch)}</span><span class="mono">${repo.headSha.slice(0, 7)} · ${escapeHtml(repo.step)}</span></li>`).join("")}</ul>
			</section>
		</div>
	</article>`;
}

const VARIANTS = {
	A: { name: "Queue", render: renderQueue },
	B: { name: "Lanes", render: renderLanes },
	C: { name: "Run page", render: renderRunPage },
};

// ---------- morph: update the live DOM to match new markup, animating only what changed ----------

const ease = "cubic-bezier(0.23, 1, 0.32, 1)";

function enter(element) {
	if (state.quiet) return;
	element.animate(reducedMotion.matches ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: ease });
}

function pulse(element) {
	if (state.quiet) return;
	const from = "2px solid var(--flash)";
	element.animate([{ outline: from, outlineOffset: "1px" }, { outline: "2px solid transparent", outlineOffset: "1px" }], { duration: 1400, easing: "ease-out" });
}

function morph(live, next) {
	if (next.hasAttribute("data-skip")) return; // drawn by script after layout
	for (const { name, value } of [...next.attributes]) if (live.getAttribute(name) !== value) live.setAttribute(name, value);
	for (const { name } of [...live.attributes]) if (!next.hasAttribute(name)) live.removeAttribute(name);
	if (live.tagName === "TIME") {
		live.textContent = ago(live.dataset.t);
		return;
	}

	if (!live.children.length && !next.children.length) {
		if (live.textContent !== next.textContent) {
			live.textContent = next.textContent;
			pulse(live.closest(".pill, .chip, .actor, .tl-sum, dd, .fact, .gate, .tool, .tile-run") ?? live);
		}
		return;
	}
	const existing = new Map([...live.children].map((child, i) => [child.dataset.k ?? `#${i}`, child]));
	[...next.children].forEach((child, i) => {
		const key = child.dataset.k ?? `#${i}`;
		let match = existing.get(key);
		existing.delete(key);
		if (match && match.tagName === child.tagName) morph(match, child);
		else {
			match?.remove();
			match = child;
			enter(match);
		}
		if (live.children[i] !== match) live.insertBefore(match, live.children[i] ?? null);
	});
	for (const stale of existing.values()) stale.remove();
}

const root = document.getElementById("app");

function render() {
	if (!state.data) return;
	const next = document.createElement("div");
	next.id = root.id; // morph syncs attributes; keep the root's own
	next.innerHTML = VARIANTS[state.variant].render();
	morph(root, next);
	if (state.variant === "B") drawEdges();
	syncChrome();
	state.quiet = false;
}

// ---------- Variant B edges (drawn after layout, skipped by morph) ----------

function drawEdges() {
	const columns = root.querySelector(".B-cols");
	const svg = columns?.querySelector(".B-edges");
	if (!svg) return;
	const origin = columns.getBoundingClientRect();
	const boxes = new Map([...columns.querySelectorAll("[data-tile]")].map((element) => [element.dataset.tile, element.getBoundingClientRect()]));
	const chain = state.hover ? chainOf(state.hover) : null;
	let paths = "";
	for (const ticket of project().tickets) {
		for (const dependency of ticket.dependsOn) {
			const from = boxes.get(dependency);
			const to = boxes.get(ticket.id);
			if (!from || !to || ticket.status === "done") continue; // done tickets wait on nothing, even if a dependency is still open
			const [x1, y1, x2, y2] = [from.right - origin.left, from.top + from.height / 2 - origin.top, to.left - origin.left, to.top + to.height / 2 - origin.top];
			const middle = (x1 + x2) / 2;
			const mark = chain ? (chain.has(dependency) && chain.has(ticket.id) ? "hl" : "dim") : "";
			paths += `<path class="edge ${mark} ${laneOf(ticketById(dependency)) === "done" ? "settled" : ""}" d="M${x1} ${y1}C${middle} ${y1} ${middle} ${y2} ${x2} ${y2}"/>`;
		}
	}
	svg.setAttribute("width", columns.scrollWidth);
	svg.setAttribute("height", columns.scrollHeight);
	svg.innerHTML = paths;
}

// ---------- floating switcher, theme, URL ----------

const bar = document.getElementById("bar");

function syncChrome() {
	document.documentElement.dataset.theme = state.theme;
	bar.querySelector("[data-bar-label]").textContent = `${state.variant} (${VARIANTS[state.variant].name})`;
	bar.querySelector("[data-bar-theme]").textContent = state.theme === "auto" ? "Theme: system" : `Theme: ${state.theme}`;
	const next = new URLSearchParams({ variant: state.variant });
	for (const key of ["theme", "project", "run", "ticket", "filter"]) {
		const value = key === "project" ? state.project : state[key === "run" ? "selectedRun" : key === "ticket" ? "selectedTicket" : key];
		if (value && value !== "auto" && !(key === "filter" && value === "all")) next.set(key, value);
	}
	history.replaceState(null, "", `?${next}`);
}

function switchVariant(step) {
	const keys = Object.keys(VARIANTS);
	state.variant = keys[(keys.indexOf(state.variant) + step + keys.length) % keys.length];
	state.quiet = true;
	render();
}

bar.addEventListener("click", (event) => {
	const button = event.target.closest("button");
	if (!button) return;
	if (button.hasAttribute("data-bar-prev")) switchVariant(-1);
	if (button.hasAttribute("data-bar-next")) switchVariant(1);
	if (button.hasAttribute("data-bar-theme")) {
		state.theme = { auto: "dark", dark: "light", light: "auto" }[state.theme];
		render();
	}
});

addEventListener("keydown", (event) => {
	if (event.target.closest("input, textarea, [contenteditable]") || event.metaKey || event.ctrlKey || event.altKey) return;
	if (event.key === "ArrowLeft") switchVariant(-1);
	if (event.key === "ArrowRight") switchVariant(1);
});

// ---------- interaction (all read-only) ----------

function reveal(selector) {
	requestAnimationFrame(() => {
		const element = root.querySelector(selector);
		if (!element) return;
		element.scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
		pulse(element);
	});
}

root.addEventListener("click", (event) => {
	const target = event.target.closest("[data-copy], [data-open], [data-run], [data-ticket], [data-tile], [data-show-done], [data-filter], [data-project]");
	if (!target) return;
	const { dataset } = target;
	if (dataset.copy) {
		navigator.clipboard.writeText(START_COMMAND(dataset.copy));
		state.copied = dataset.copy;
		setTimeout(() => {
			state.copied = "";
			render();
		}, 1600);
	} else if (dataset.open !== undefined) {
		state.open.has(dataset.open) ? state.open.delete(dataset.open) : state.open.add(dataset.open);
	} else if (dataset.run) {
		state.selectedRun = dataset.run;
		if (state.variant !== "C") reveal(`[data-k="run:${dataset.run}"]`);
	} else if (dataset.ticket) {
		state.selectedTicket = dataset.ticket;
		if (state.variant === "A" || state.variant === "C") {
			state.open.add(`t:${dataset.ticket}`);
			state.showDone = true;
			state.filter = "all";
		}
		reveal(`[data-k="t:${dataset.ticket}"]`);
	} else if (dataset.tile) {
		state.selectedTicket = dataset.tile;
	} else if (dataset.showDone !== undefined) {
		state.showDone = !state.showDone;
	} else if (dataset.filter) {
		state.filter = dataset.filter;
	} else if (dataset.project) {
		state.project = dataset.project;
		state.quiet = true;
	}
	render();
});

root.addEventListener("keydown", (event) => {
	if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-tile]")) {
		event.preventDefault();
		state.selectedTicket = event.target.dataset.tile;
		render();
	}
});

function setHover(id) {
	if (state.hover === id) return;
	state.hover = id;
	render();
}

root.addEventListener("pointerover", (event) => event.target.closest("[data-tile]") && setHover(event.target.closest("[data-tile]").dataset.tile));
root.addEventListener("pointerout", (event) => !event.relatedTarget?.closest?.("[data-tile]") && setHover(""));
root.addEventListener("focusin", (event) => event.target.matches("[data-tile]") && setHover(event.target.dataset.tile));
root.addEventListener("focusout", (event) => event.target.matches("[data-tile]") && setHover(""));
addEventListener("resize", () => state.variant === "B" && drawEdges());

// ---------- polling ----------

let lastBody = "";

async function poll() {
	try {
		const response = await fetch("/api/board", { cache: "no-store" });
		const body = await response.text();
		state.error = false;
		state.fetchedAt = new Date().toISOString();
		if (body !== lastBody) {
			lastBody = body;
			state.data = JSON.parse(body);
			if (!state.project) state.project = state.data.projects[0]?.name ?? "";
		}
	} catch {
		state.error = true;
	}
	render();
}

setInterval(() => !document.hidden && poll(), POLL_MS);
setInterval(() => root.querySelectorAll("time[data-t]").forEach((element) => (element.textContent = ago(element.dataset.t))), 1000);
document.addEventListener("visibilitychange", () => !document.hidden && poll());
poll();
