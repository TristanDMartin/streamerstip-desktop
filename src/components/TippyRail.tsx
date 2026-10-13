import { useState, type RefObject } from "react";

export const TIPPY_NOT_CONNECTED = "Tippy is not connected yet.";

const SUGGESTIONS = [
  "Where did I talk about GTA VI?",
  "Find my best clips",
  "Create 4 Shorts",
  "Remove dead space",
  "Build a YouTube edit",
];

interface TippyRailProps {
  onSubmit: (text: string) => Promise<string>;
  composerRef?: RefObject<HTMLTextAreaElement>;
}

export function TippyRail({ onSubmit, composerRef }: TippyRailProps) {
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState(TIPPY_NOT_CONNECTED);
  const [isSending, setIsSending] = useState(false);

  async function submit() {
    const text = draft.trim();
    if (!text || isSending) {
      return;
    }
    setIsSending(true);
    const message = await onSubmit(text);
    setReply(message);
    setIsSending(false);
  }

  return (
    <aside className="tippy-rail" aria-label="Tippy">
      <p className="tippy-kicker">Tippy</p>
      <h2>What are we making today?</h2>
      <p className="tippy-status" data-testid="tippy-status">
        {TIPPY_NOT_CONNECTED}
      </p>
      <div className="suggestion-list">
        <p className="section-label">Suggestions</p>
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="suggestion"
            onClick={() => setDraft(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
      <label className="composer-label" htmlFor="tippy-composer">
        Ask Tippy
      </label>
      <textarea
        id="tippy-composer"
        ref={composerRef}
        data-testid="tippy-composer"
        value={draft}
        placeholder="Ask Tippy…"
        rows={4}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        type="button"
        className="tippy-submit"
        data-testid="tippy-submit"
        disabled={isSending || draft.trim().length === 0}
        onClick={() => {
          void submit();
        }}
      >
        Ask Tippy
      </button>
      <p className="tippy-reply" data-testid="tippy-reply">
        {reply}
      </p>
    </aside>
  );
}
