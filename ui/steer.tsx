import { useState, type FormEvent } from "react";
import { abortInstruction, instructions } from "../cli/hub/types.ts";

type Result = { ok: boolean; text: string };

/** Posts one steering action. The page names a project or run, never a terminal: the server picks the terminal. */
async function steer(name: string, params: Record<string, unknown>): Promise<Result> {
  try {
    const response = await fetch(`/api/actions/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const body = (await response.json()) as { error?: string };
    return response.ok
      ? { ok: true, text: "Sent · not confirmed read" }
      : {
          ok: false,
          text: `${body.error ?? response.status} · nothing was sent`,
        };
  } catch {
    return { ok: false, text: "The hub did not answer · nothing was sent" };
  }
}

const Status = ({ result }: { result: Result | null }) =>
  result && (
    <div
      className={`steer-status ${result.ok ? "ok" : "bad"}`}
      role={result.ok ? "status" : "alert"}
    >
      <b>{result.ok ? "Sent" : "Failed"}</b> {result.text}
    </div>
  );

/** One line to a terminal the server picks from `action` and `params`. Standalone: the run detail and ARK-179 embed it. */
function MessageForm({
  action,
  params,
  label,
  placeholder,
}: {
  action: string;
  params: Record<string, unknown>;
  label: string;
  placeholder: string;
}) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (text.trim() === "") return;
    const outcome = await steer(action, { ...params, text });
    setResult(outcome);
    if (outcome.ok) setText("");
  }
  return (
    <form className="steer" onSubmit={(event) => void submit(event)}>
      <label>
        <span className="steer-label">{label}</span>
        <span className="steer-row">
          <input
            value={text}
            placeholder={placeholder}
            autoComplete="off"
            onChange={(event) => setText(event.target.value)}
          />
          <button className="btn primary" type="submit">
            Send
          </button>
        </span>
      </label>
      <Status result={result} />
    </form>
  );
}

export const RunLeadMessage = ({ run }: { run: string }) => (
  <MessageForm
    action="run-lead-message"
    params={{ run }}
    label="Message run lead"
    placeholder="e.g. skip the review step for the docs change"
  />
);

const fixedActions: [keyof typeof instructions, string][] = [
  ["approve-and-queue", "Approve and queue"],
  ["reorder-queue", "Reorder queue"],
  ["pause", "Pause"],
  ["resume", "Resume"],
  ["retry-stuck-agent", "Retry stuck agent"],
];

/** The Master Chief box of one project: free text, fixed instructions, and Spawn when no Master Chief is live. */
export function ChiefBox({ project, live }: { project: string; live: boolean | null }) {
  const [result, setResult] = useState<Result | null>(null);
  const [spawned, setSpawned] = useState<Result | null>(null);
  return (
    <section className="chief-box" aria-label={`Master Chief for ${project}`}>
      <h3>
        <b>{project}</b> Master Chief
      </h3>
      {live === false && (
        <div className="steer-row">
          <button
            className="btn primary"
            onClick={() =>
              void steer("chief-spawn", { project }).then((outcome) =>
                setSpawned(
                  outcome.ok ? { ok: true, text: "Master Chief opened in Orca" } : outcome,
                ),
              )
            }
          >
            Spawn Master Chief
          </button>
          <span className="hint">No live Master Chief for this project.</span>
        </div>
      )}
      {spawned && (
        <div className={`steer-status ${spawned.ok ? "ok" : "bad"}`} role="status">
          {spawned.text}
        </div>
      )}
      <MessageForm
        action="chief-message"
        params={{ project }}
        label="Message Master Chief"
        placeholder="e.g. ARK-181 first, then ARK-179"
      />
      <div className="steer-row wrap">
        {fixedActions.map(([instruction, label]) => (
          <button
            key={instruction}
            className="btn sm"
            title={instructions[instruction]}
            onClick={() =>
              void steer("chief-instruction", { project, instruction }).then(setResult)
            }
          >
            {label}
          </button>
        ))}
      </div>
      <Status result={result} />
    </section>
  );
}

/** Abort needs this dialog: it shows the exact line, and only Send abort posts `confirmed: true`. */
export function AbortButton({ project, run }: { project: string; run: string }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  return (
    <>
      <button className="btn sm danger" onClick={() => setOpen(true)}>
        Abort…
      </button>
      <Status result={result} />
      {open && (
        <div className="scrim" onClick={() => setOpen(false)}>
          <div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="abort-title"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.key === "Escape" && setOpen(false)}
          >
            <h2 id="abort-title">Abort run {run}?</h2>
            <div className="body">
              <p>This types the following into the Master Chief terminal for {project}.</p>
              <div className="steer-quote">{abortInstruction(run)}</div>
            </div>
            <div className="foot">
              <button className="btn" autoFocus onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                className="btn danger solid"
                onClick={() =>
                  void steer("chief-instruction", {
                    project,
                    instruction: "abort",
                    run,
                    confirmed: true,
                  }).then((outcome) => {
                    setResult(outcome);
                    setOpen(false);
                  })
                }
              >
                Send abort
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
