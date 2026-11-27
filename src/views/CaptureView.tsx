import { useEffect, useMemo, useState } from "react";

import { onObsChatCapture } from "../api";
import { TippyApp, type AppStatus } from "../obs/app";
import { parseChord, createHotkeyController } from "../obs/hotkey";
import {
  clipsAuthorizedForUpload,
  rememberClip,
  setUploadAuthorization,
  type StoredClip,
} from "../obs/inventory";
import { obsReadiness } from "../obs/readiness";

const INVENTORY_KEY = "tippy.obsInventory";

interface CaptureViewProps {
  deviceId: string;
  chatEnabled: boolean;
}

export function CaptureView({ deviceId, chatEnabled }: CaptureViewProps) {
  const app = useMemo(
    () => new TippyApp({ deviceId, hostname: "this-pc" }),
    [deviceId],
  );
  const [status, setStatus] = useState<AppStatus>(() => app.status());
  const [password, setPassword] = useState("");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState(4455);
  const [consent, setConsent] = useState(false);
  const [inputName, setInputName] = useState("");
  const [inventory, setInventory] = useState<StoredClip[]>(() => loadInventory());
  const report = obsReadiness(status);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = app.status();
      setStatus(next);
      setInventory((current) => {
        const merged = mergeInventory(current, next.candidates);
        if (merged !== current) saveInventory([...merged]);
        return [...merged];
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [app]);

  useEffect(() => {
    const chord = parseChord(status.hotkey);
    const controller = createHotkeyController(chord, () => {
      void app.saveMoment("hotkey").then(() => setStatus(app.status()));
    });
    const down = (event: KeyboardEvent) => {
      controller.handle({
        type: "down",
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
        meta: event.metaKey,
        key: event.key,
      });
    };
    const up = (event: KeyboardEvent) => {
      controller.handle({
        type: "up",
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
        meta: event.metaKey,
        key: event.key,
      });
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [app, status.hotkey]);

  useEffect(() => {
    if (!chatEnabled) return undefined;
    let unlisten: (() => void) | undefined;
    void onObsChatCapture((signal) => {
      const result = app.ingestChat(
        {
          idempotencyKey: signal.idempotencyKey ?? "",
          phrase: signal.phrase ?? "",
        },
        true,
      );
      if (!result.accepted) setStatus(app.status());
    }).then((stop) => {
      unlisten = stop;
    });
    return () => {
      unlisten?.();
    };
  }, [app, chatEnabled]);

  async function save(trigger: "manual" | "hotkey") {
    const result = await app.saveMoment(trigger);
    const next = app.status();
    setStatus(next);
    if (result.ok && !result.duplicate) {
      setInventory((current) => {
        const stored = rememberClip(current, {
          localPath: result.candidate.localPath,
          fileSizeBytes: result.candidate.fileSizeBytes,
          trigger: result.candidate.trigger,
          idempotencyKey: result.candidate.idempotencyKey,
          triggerTimestamp: result.candidate.triggerTimestamp,
          uploadAuthorized: false,
        });
        if (stored !== current) saveInventory([...stored]);
        return [...stored];
      });
    }
  }

  return (
    <section className="capture-board" data-testid="capture-board">
      <header className="page-head">
        <p className="section-label">OBS replay</p>
        <h1>Capture</h1>
        <p className="lede">
          Replays stay on this PC. Twitch clips are not downloaded. Nothing is
          uploaded or transcribed from here.
        </p>
      </header>
      <section className="panel" data-testid="obs-readiness">
        <h2>Pre-stream check</h2>
        <ul>
          {report.items.map((item) => (
            <li key={item.id}>
              {item.ok ? "Ready" : "Not ready"} · {item.label}. {item.detail}
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2>OBS WebSocket</h2>
        <label>
          Host
          <input value={host} onChange={(event) => setHost(event.target.value)} />
        </label>
        <label>
          Port
          <input
            type="number"
            value={port}
            onChange={(event) => setPort(Number(event.target.value))}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            void app.connect({ host, port, password }).then(() => setStatus(app.status()));
          }}
        >
          Connect
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void app.disconnect().then(() => setStatus(app.status()));
          }}
        >
          Disconnect
        </button>
        <p data-testid="capture-status">{status.lastMessage}</p>
      </section>
      <section className="panel">
        <h2>Save moment</h2>
        <p>Hotkey while this window is focused: {status.hotkey}</p>
        <button type="button" onClick={() => void save("manual")}>
          Save moment
        </button>
        <p>{status.guidance}</p>
        <label>
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          I want Tippy to start the OBS replay buffer. This does not change stream or recording settings.
        </label>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void app.startReplayBuffer(consent).then(() => setStatus(app.status()));
          }}
        >
          Start replay buffer
        </button>
      </section>
      <section className="panel">
        <h2>Audio spike</h2>
        <p>{status.audioCopy}</p>
        <label>
          OBS input name
          <input
            value={inputName}
            placeholder="Mic/Aux"
            onChange={(event) => setInputName(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void app.calibrateLive(3000).then(() => setStatus(app.status()));
          }}
        >
          Calibrate 3 seconds
        </button>
        <label>
          <input
            type="checkbox"
            checked={status.audioEnabled}
            onChange={(event) => {
              const result = app.setAudio({
                enabled: event.target.checked,
                inputName,
              });
              setStatus(app.status());
              if (!result.ok) setStatus(app.status());
            }}
          />
          Turn on the audio spike
        </label>
      </section>
      <section className="panel">
        <h2>On this PC</h2>
        <p>
          {chatEnabled
            ? "Chat replay is on. A local request to 127.0.0.1:4736 can save one replay. Twitch chat is not read here."
            : "Chat replay is off. Turn on desktopChatReplay in flags.json before the Tippy bot may ask this PC to save."}
        </p>
        <ul data-testid="capture-inventory">
          {inventory.map((item) => (
            <li key={item.idempotencyKey}>
              {item.trigger} · {item.fileSizeBytes} bytes · {item.localPath}
              <label>
                <input
                  type="checkbox"
                  checked={item.uploadAuthorized}
                  onChange={(event) => {
                    const next = setUploadAuthorization(
                      inventory,
                      item.idempotencyKey,
                      event.target.checked,
                    );
                    setInventory(next);
                    saveInventory(next);
                  }}
                />
                I authorize uploading this replay later
              </label>
            </li>
          ))}
        </ul>
        <p>
          {clipsAuthorizedForUpload(inventory).length} selected for a later upload.
          This build does not send them.
        </p>
      </section>
    </section>
  );
}

function mergeInventory(
  current: readonly StoredClip[],
  candidates: AppStatus["candidates"],
): readonly StoredClip[] {
  let items: readonly StoredClip[] = current;
  for (const candidate of candidates) {
    items = rememberClip(items, {
      localPath: candidate.localPath,
      fileSizeBytes: candidate.fileSizeBytes,
      trigger: candidate.trigger,
      idempotencyKey: candidate.idempotencyKey,
      triggerTimestamp: candidate.triggerTimestamp,
      uploadAuthorized: false,
    });
  }
  return items;
}

function loadInventory(): StoredClip[] {
  try {
    const raw = window.localStorage.getItem(INVENTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredClip[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveInventory(items: StoredClip[]): void {
  try {
    window.localStorage.setItem(INVENTORY_KEY, JSON.stringify(items));
  } catch {
    // The files remain on disk if the browser store is unavailable.
  }
}
