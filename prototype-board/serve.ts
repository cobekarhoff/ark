// PROTOTYPE (throwaway, branch prototype/board, never merged): read-only Ark board server.
// Run: `bun prototype-board/serve.ts`. Binds 127.0.0.1 on a free port. Rebuilds the JSON from files on every request.
// Reads only ~/.ark (override with ARK_HOME for fixtures). Never writes anything.
import { existsSync, openSync, closeSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Json = Record<string, unknown>;

const arkHome = process.env.ARK_HOME ?? join(homedir(), ".ark");
const publicDirectory = import.meta.dir;
const sessionTailBytes = 1024 * 1024;
const ledgerEventsShown = 8;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const asRecord = (value: unknown): Json => (isRecord(value) ? value : {});
const asText = (value: unknown): string => (typeof value === "string" ? value : "");
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asTextList = (value: unknown): string[] => asList(value).filter((item): item is string => typeof item === "string");

function readJson(path: string): Json {
	try {
		return asRecord(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return {};
	}
}

function listDirectory(path: string): string[] {
	try {
		return readdirSync(path).sort();
	} catch {
		return [];
	}
}

// ---------- tickets ----------

interface Ticket {
	id: string;
	title: string;
	status: string;
	milestone: string;
	traces: string[];
	dependsOn: string[];
	criteria: { id: string; text: string }[];
	readiness: "ready" | "blocked" | "in_progress" | "done";
	waitingOn: string[];
	unlocks: string[];
	layer: number;
	runs: string[];
	activeRun: string | null;
}

function readTickets(projectDirectory: string): Ticket[] {
	const directory = join(projectDirectory, "tickets");
	const tickets: Ticket[] = [];
	for (const file of listDirectory(directory)) {
		if (!/^[A-Z]+-\d+\.md$/.test(file)) continue;
		const source = readFileSync(join(directory, file), "utf8");
		const match = source.match(/^---\n([\s\S]*?)\n---/);
		if (!match) continue;
		const front = asRecord(Bun.YAML.parse(match[1]));
		tickets.push({
			id: asText(front.id) || file.replace(".md", ""),
			title: asText(front.title),
			status: asText(front.status),
			milestone: asText(front.milestone),
			traces: asTextList(front.traces),
			dependsOn: asTextList(front.depends_on),
			criteria: asList(front.acceptance_criteria).map((item) => ({ id: asText(asRecord(item).id), text: asText(asRecord(item).text) })),
			readiness: "blocked",
			waitingOn: [],
			unlocks: [],
			layer: 0,
			runs: [],
			activeRun: null,
		});
	}
	const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
	const layerOf = (ticket: Ticket, seen: Set<string>): number => {
		if (seen.has(ticket.id)) return 0; // cycle guard
		seen.add(ticket.id);
		const depth = ticket.dependsOn.map((id) => byId.get(id)).filter((dep): dep is Ticket => !!dep).map((dep) => layerOf(dep, new Set(seen)) + 1);
		return Math.max(0, ...depth);
	};
	for (const ticket of tickets) {
		ticket.layer = layerOf(ticket, new Set());
		ticket.waitingOn = ticket.dependsOn.filter((id) => byId.get(id)?.status !== "done");
		for (const id of ticket.dependsOn) byId.get(id)?.unlocks.push(ticket.id);
		if (ticket.status === "done") ticket.readiness = "done";
		else if (ticket.status === "in_progress") ticket.readiness = "in_progress";
		else ticket.readiness = ticket.status === "ready" && ticket.waitingOn.length === 0 ? "ready" : "blocked";
	}
	return tickets;
}

// ---------- runs ----------

interface LedgerEvent {
	seq: number;
	ts: string;
	type: string;
	summary: string;
}

interface Session {
	model: string;
	tool: string;
	toolIntent: string;
	toolRunning: boolean;
	ts: string;
	idle: boolean; // newest message entry is an assistant message with no toolCall: the turn ended
	idleSince: string;
	idleText: string; // first lines of that last assistant text
}

interface Run {
	id: string;
	project: string;
	ticket: string;
	playbook: string;
	state: string;
	status: string;
	outcome: string | null;
	round: number;
	nextAction: { kind: string; agent: string };
	gates: { name: string; answer: string | null; by: string; at: string; waiting: boolean }[];
	waitingGate: string | null;
	needsYou: string | null;
	needsKind: "gate" | "status" | "session" | null;
	needsText: string; // for "session": the orchestrator's last words
	waitingSince: string | null;
	criteria: Record<string, string>;
	repos: { name: string; branch: string; headSha: string; step: string }[];
	findings: Record<string, number>;
	ledger: LedgerEvent[];
	ledgerCount: number;
	startedAt: string;
	updatedAt: string;
	session: Session | null;
}

const gateNames = ["criteria", "plan", "evidence", "escalation"];

function summarize(type: string, data: Json): string {
	const pick = (...keys: string[]) => keys.map((key) => asText(data[key])).find(Boolean) ?? "";
	if (type === "gate.packet" || type === "gate.answered") return [pick("gate"), asText(data.answer)].filter(Boolean).join(" · ");
	if (type === "run.started") return `${pick("playbook")} · ${asList(data.acs).length} criteria`;
	if (type === "route.chosen") return pick("playbook");
	if (type === "test.result" || type === "test.red_green") return `attempt ${data.attempt ?? "?"} ${Object.entries(asRecord(data.acs)).map(([id, verdict]) => `${id.split("-").pop()}:${verdict}`).join(" ")}`.trim();
	if (type === "findings.recorded") return `${asList(data.ids).length} finding(s), ${asRecord(data.buckets).act_on ?? 0} to act on`;
	if (type.startsWith("implementer") || type === "worktree.created") return pick("repo") + (pick("head_sha") ? ` @ ${pick("head_sha").slice(0, 7)}` : "");
	return "";
}

function readSession(runDirectory: string): Session | null {
	const pointer = readJson(join(runDirectory, ".main-session"));
	const file = asText(pointer.file);
	if (!file || !existsSync(file)) return null;
	const size = statSync(file).size;
	const start = Math.max(0, size - sessionTailBytes);
	const buffer = Buffer.alloc(size - start);
	const descriptor = openSync(file, "r");
	readSync(descriptor, buffer, 0, buffer.length, start);
	closeSync(descriptor);
	const lines = buffer.toString("utf8").split("\n");
	if (start > 0) lines.shift(); // first line of a tail read is partial
	const finishedToolCalls = new Set<string>();
	let latest: Session | null = null;
	let newestSeen = false;
	let idle = { idle: false, idleSince: "", idleText: "" };
	for (let i = lines.length - 1; i >= 0; i--) {
		let line: Json;
		try {
			line = asRecord(JSON.parse(lines[i]));
		} catch {
			continue;
		}
		const message = asRecord(line.message);
		if (!newestSeen && line.type === "message") {
			newestSeen = true;
			const parts = asList(message.content).map(asRecord);
			if (message.role === "assistant" && !parts.some((part) => part.type === "toolCall")) {
				const text = parts.filter((part) => part.type === "text").map((part) => asText(part.text)).join("\n");
				idle = { idle: true, idleSince: asText(line.timestamp), idleText: text.split("\n").map((row) => row.trim()).filter(Boolean).slice(0, 2).join("\n").slice(0, 280) };
			}
		}
		if (message.role === "toolResult") finishedToolCalls.add(asText(message.toolCallId));
		if (message.role !== "assistant") continue;
		const provider = asText(message.provider);
		const model = asText(message.model);
		latest ??= { model: provider && !model.includes("/") ? `${provider}/${model}` : model, tool: "", toolIntent: "", toolRunning: false, ts: asText(line.timestamp), ...idle };
		const toolCalls = asList(message.content).map(asRecord).filter((part) => part.type === "toolCall");
		const lastCall = toolCalls[toolCalls.length - 1];
		if (!lastCall) continue; // text-only turn: keep looking back for the last tool
		latest.tool = asText(lastCall.name);
		latest.toolIntent = asText(lastCall.intent);
		latest.toolRunning = !finishedToolCalls.has(asText(lastCall.id));
		break;
	}
	return latest;
}

function readRun(project: string, runDirectory: string, id: string): Run {
	const state = readJson(join(runDirectory, "state.json"));
	const events: LedgerEvent[] = [];
	const answered = new Map<string, Json>();
	const gatePacketTimes = new Map<string, string>();
	try {
		for (const line of readFileSync(join(runDirectory, "ledger.ndjson"), "utf8").split("\n")) {
			if (!line.trim()) continue;
			const event = asRecord(JSON.parse(line));
			const data = asRecord(event.data);
			const type = asText(event.type);
			events.push({ seq: Number(event.seq), ts: asText(event.ts), type, summary: summarize(type, data) });
			if (type === "gate.packet") gatePacketTimes.set(asText(data.gate), asText(event.ts));
		}
	} catch {
		/* run folder mid-write: show what parsed */
	}
	for (const [name, answer] of Object.entries(asRecord(state.gates))) answered.set(name, asRecord(answer));
	const stateName = asText(state.state);
	const status = asText(state.status);
	const waitingGate = stateName.startsWith("awaiting_") ? stateName.slice("awaiting_".length) : null;
	const session = readSession(runDirectory);
	const sessionIdle = !!session?.idle && status === "active" && !asText(state.outcome); // active run, orchestrator turn ended
	const needsYou = waitingGate ? `${waitingGate} gate` : status && status !== "active" && status !== "done" ? `status ${status}` : sessionIdle ? "orchestrator waiting for you in its session" : null;
	const needsKind = waitingGate ? "gate" : needsYou ? (sessionIdle && status === "active" ? "session" : "status") : null;
	const lastTs = events.length ? events[events.length - 1].ts : "";
	const gateList = [...new Set([...gateNames, ...answered.keys(), ...gatePacketTimes.keys()])];
	const findings: Record<string, number> = {};
	for (const file of listDirectory(join(runDirectory, "artifacts", "findings"))) {
		for (const finding of asList(JSON.parse(readFileSync(join(runDirectory, "artifacts", "findings", file), "utf8")))) {
			const bucket = asText(asRecord(finding).bucket) || "unsorted";
			findings[bucket] = (findings[bucket] ?? 0) + 1;
		}
	}
	const next = asRecord(state.next_action);
	return {
		id,
		project,
		ticket: asText(state.ticket),
		playbook: asText(state.playbook),
		state: stateName,
		status,
		outcome: asText(state.outcome) || null,
		round: Number(state.round ?? 0),
		nextAction: { kind: asText(next.kind), agent: asText(next.agent) },
		gates: gateList.map((name) => ({
			name,
			answer: asText(answered.get(name)?.answer) || null,
			by: asText(answered.get(name)?.by).replace(/\s*<.*?>/, ""),
			at: asText(answered.get(name)?.at) || gatePacketTimes.get(name) || "",
			waiting: name === waitingGate,
		})),
		waitingGate,
		needsYou,
		needsKind,
		needsText: needsKind === "session" ? (session?.idleText ?? "") : "",
		waitingSince: needsYou ? ((waitingGate && gatePacketTimes.get(waitingGate)) || (needsKind === "session" && session?.idleSince) || lastTs || null) : null,
		criteria: Object.fromEntries(Object.entries(asRecord(state.acs)).map(([criterion, verdict]) => [criterion, asText(verdict)])),
		repos: asList(state.repos).map(asRecord).map((repo) => ({ name: asText(repo.name), branch: asText(repo.branch), headSha: asText(repo.head_sha), step: asText(repo.step) })),
		findings,
		ledger: events.slice(-ledgerEventsShown).reverse(),
		ledgerCount: events.length,
		startedAt: events[0]?.ts ?? "",
		updatedAt: lastTs,
		session,
	};
}

// ---------- board ----------

function buildBoard() {
	const projects = listDirectory(join(arkHome, "projects")).filter((name) => statSync(join(arkHome, "projects", name)).isDirectory());
	const board = projects.map((name) => {
		const projectDirectory = join(arkHome, "projects", name);
		const tickets = readTickets(projectDirectory);
		const runs = listDirectory(join(projectDirectory, "runs")).filter((id) => !id.startsWith(".") && existsSync(join(projectDirectory, "runs", id, "state.json"))).map((id) => readRun(name, join(projectDirectory, "runs", id), id));
		runs.sort((a, b) => Number(!!b.needsYou) - Number(!!a.needsYou) || Number(b.status === "active") - Number(a.status === "active") || b.updatedAt.localeCompare(a.updatedAt));
		for (const run of runs) {
			const ticket = tickets.find((candidate) => candidate.id === run.ticket);
			if (!ticket) continue;
			ticket.runs.push(run.id);
			if (run.status === "active" && !ticket.activeRun) ticket.activeRun = run.id;
		}
		return { name, tickets, runs };
	});
	return { projects: board };
}

// ---------- server ----------

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/api/board") return Response.json(buildBoard(), { headers: { "cache-control": "no-store" } });
		const files: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
		const file = files[pathname];
		if (!file) return new Response("not found", { status: 404 });
		return new Response(Bun.file(join(publicDirectory, file)), { headers: { "cache-control": "no-store" } });
	},
});

console.log(`Ark board (PROTOTYPE, read-only): http://127.0.0.1:${server.port}/?variant=A   (variants A, B, C)`);
