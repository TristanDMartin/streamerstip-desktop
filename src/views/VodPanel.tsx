import { useMemo, useState } from "react";

import { VOD_STEPS } from "../obs/mediaHandoff";
import { decideDesktopProcessing, UNKNOWN_GPU, type ObsObservation, type ProcessingMode } from "../obs/scheduler";
import { planReplayManifest } from "../obs/sidecarPlan";
import { VodDesk, type SidecarRunner } from "../obs/vodDesk";

interface VodPanelProps {
  enabled: boolean;
  ownerId: string;
  mode: ProcessingMode;
  activity: ObsObservation;
  suspendProcessing: boolean;
  replayPath: string;
  replayAuthorized: boolean;
  replaySavedAt: string;
}

const EMPTY_ACTIVITY: ObsObservation = {
  processDetected: false,
  streaming: false,
  recording: false,
  droppedFrames: null,
  laggedFrames: null,
};

export function VodPanel({
  enabled,
  ownerId,
  mode,
  activity,
  suspendProcessing,
  replayPath,
  replayAuthorized,
  replaySavedAt,
}: VodPanelProps) {
  const decision = decideDesktopProcessing({
    requestedMode: mode,
    obs: activity,
    gpu: UNKNOWN_GPU,
  });
  const [folder, setFolder] = useState("");
  const [files, setFiles] = useState("");
  const [cli, setCli] = useState("");
  const [workDir, setWorkDir] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [progress, setProgress] = useState("Idle.");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [category, setCategory] = useState("");
  const desk = useMemo(() => new VodDesk(browserSidecar, {
    nodePath: "node",
    scannerCli: cli,
    workDir,
  }, enabled), [cli, enabled, workDir]);
  const listed = files.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);

  return (
    <section className="panel" data-testid="vod-stub">
      <h2>VOD intelligence</h2>
      <p>
        {enabled
          ? "The local scanner is flagged on. Nothing is uploaded."
          : "desktopVodIntelligence is off. The steps below stay in this app and do not run."}
      </p>
      <p>
        {decision.downgraded
          ? `Processing stays on ${decision.effectiveMode} (${decision.reasons.join(", ")}).`
          : `Processing is ${decision.effectiveMode}. Policy ${decision.policy}.`}
        {suspendProcessing
          ? " Background processing is suspended until CPU and memory stay under the resume line."
          : " Background processing is allowed by the resource monitor."}
      </p>
      <ol>
        {VOD_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <label>
        Folder
        <input value={folder} onChange={(event) => setFolder(event.target.value)} />
      </label>
      <label>
        Recordings, one path per line
        <textarea value={files} onChange={(event) => setFiles(event.target.value)} />
      </label>
      <label>
        Scanner CLI
        <input value={cli} onChange={(event) => setCli(event.target.value)} />
      </label>
      <label>
        Work folder
        <input value={workDir} onChange={(event) => setWorkDir(event.target.value)} />
      </label>
      <label>
        <input
          type="checkbox"
          checked={authorized}
          onChange={(event) => setAuthorized(event.target.checked)}
        />
        I authorize local analysis of these files
      </label>
      <button type="button" className="secondary" onClick={() => void runAuthorize()}>
        Authorize folder
      </button>
      <button type="button" className="secondary" onClick={() => void runScan()}>
        Scan
      </button>
      <button type="button" className="secondary" onClick={() => desk.cancel()}>
        Cancel
      </button>
      <p>{progress}</p>
      <ul>
        {candidates.map((id) => (
          <li key={id}>
            <label>
              <input
                type="checkbox"
                checked={selected.includes(id)}
                onChange={(event) => {
                  setSelected((current) => (
                    event.target.checked ? [...current, id] : current.filter((item) => item !== id)
                  ));
                }}
              />
              {id}
            </label>
          </li>
        ))}
      </ul>
      <button type="button" className="secondary" onClick={() => void runEdit()}>
        Send selected
      </button>
      <ul>
        {outputs.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <label>
        Replay category
        <input value={category} onChange={(event) => setCategory(event.target.value)} />
      </label>
      <button type="button" className="secondary" onClick={() => void runReplay()}>
        Send checked replay
      </button>
    </section>
  );

  async function runAuthorize(): Promise<void> {
    const result = await desk.authorize(ownerId, folder);
    setProgress(result.ok ? "Folder grant is local. Nothing was uploaded." : result.reason);
  }

  async function runScan(): Promise<void> {
    setProgress("Starting.");
    const first = listed[0] ?? "";
    const result = await desk.scan({
      grantPath: workDir ? `${workDir}/vod-grant.json` : "",
      filePath: first,
      authorized: authorized && listed.includes(first),
      mode,
      activity: activity ?? EMPTY_ACTIVITY,
      resources: { suspendProcessing },
      onLine: (line) => setProgress(line),
    });
    if (!result.ok) {
      setProgress(result.reason);
      return;
    }
    const lines = (result.result?.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    setCandidates(lines);
    setProgress(lines.length > 0 ? "Candidates are ready to review." : "Scan finished with no candidates.");
  }

  async function runEdit(): Promise<void> {
    const sampleId = selected[0];
    if (!sampleId) {
      setProgress("not_selected");
      return;
    }
    const result = await desk.edit({
      manifestPath: workDir ? `${workDir}/manifest.json` : "",
      ownerId,
      sampleId,
      selected: true,
      mode,
      activity,
      resources: { suspendProcessing },
    });
    if (!result.ok) {
      setProgress(result.reason);
      return;
    }
    setOutputs((result.result?.stdout ?? "").split("\n").filter(Boolean));
    setProgress("Pipeline outputs are local. Nothing was uploaded.");
  }

  function runReplay(): void {
    const grant = replayAuthorized && replayPath
      ? {
        ownerId,
        replayPath,
        savedAt: replaySavedAt,
        consent: "creator_authorized_local_replay" as const,
      }
      : null;
    const planned = planReplayManifest({ grant, category, durationSec: 30 });
    setProgress(planned.ok ? "Replay manifest is ready for the local pipeline." : planned.reason);
  }
}

const browserSidecar: SidecarRunner = async (run, signal) => {
  const { invoke } = await import("@tauri-apps/api/core");
  const id = await invoke<string>("sidecar_start", {
    program: run.argv[0],
    args: run.argv.slice(1),
  });
  const abort = (): void => {
    void invoke("sidecar_cancel", { id });
  };
  signal.addEventListener("abort", abort);
  try {
    const stdout = await invoke<string>("sidecar_wait", { id });
    return { code: 0, stdout };
  } finally {
    signal.removeEventListener("abort", abort);
  }
};
