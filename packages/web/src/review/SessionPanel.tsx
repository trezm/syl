import { useCallback, useEffect, useState } from "react";
import type { Finding, ReviewRun } from "@syl/core";
import {
  fetchChannelSessions,
  pushToSession,
  type ChannelSession,
  type ChannelSetup,
} from "../api";

/**
 * Hands review context to a Claude Code session you already have running.
 *
 * One-way on purpose: syl pushes a finding or a question over the channel, and
 * you read the answer in the session itself, where you were working anyway.
 * Nothing is ever sent without a click, which is also what keeps GitHub-authored
 * text out of your context by default.
 */

/** Live sessions, polled — one can appear or exit while a review is open. */
export function useChannelSessions() {
  const [sessions, setSessions] = useState<ChannelSession[]>([]);
  const [setup, setSetup] = useState<ChannelSetup | null>(null);

  const refresh = useCallback(async () => {
    const data = await fetchChannelSessions();
    setSessions(data.sessions);
    setSetup(data.setup);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { sessions, setup, refresh };
}

function Setup({ setup }: { setup: ChannelSetup }) {
  return (
    <div className="px-3 py-3 space-y-3 text-xs text-gray-500 leading-relaxed">
      <p>
        No Claude Code session is listening. Channels are a research preview, so
        a session has to opt in explicitly.
      </p>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-gray-600 mb-1">
          1. Add to <span className="font-mono">.mcp.json</span>
        </div>
        <pre className="bg-gray-900 border border-gray-800 rounded p-2 overflow-x-auto text-[10px] text-gray-400">
          {setup.mcpConfig}
        </pre>
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-gray-600 mb-1">
          2. Start the session
        </div>
        <pre className="bg-gray-900 border border-gray-800 rounded p-2 overflow-x-auto text-[10px] text-gray-400">
          {setup.command}
        </pre>
      </div>
      <p className="text-gray-600">
        That flag bypasses the channel allowlist and shows a full-screen warning
        first. On Team or Enterprise plans an admin has to enable channels
        separately.
      </p>
    </div>
  );
}

export default function SessionPanel({
  run,
  activeFinding,
  activeFindingIndex,
  sessions,
  setup,
  onClose,
}: {
  run: ReviewRun;
  /** The finding the user last jumped to, sent along as context. */
  activeFinding: Finding | null;
  /**
   * Its position in the sorted findings list. The server addresses findings by
   * index rather than trusting the browser to hand back a whole finding object.
   */
  activeFindingIndex: number | null;
  sessions: ChannelSession[];
  setup: ChannelSetup | null;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ label: string; at: string }[]>([]);

  // Default to a session in this project, and re-pick if the chosen one exits.
  useEffect(() => {
    if (target && sessions.some((s) => s.sessionId === target)) return;
    const preferred = sessions.find((s) => s.matchesProject) ?? sessions[0];
    setTarget(preferred?.sessionId ?? null);
  }, [sessions, target]);

  const send = async (kind: "finding" | "question") => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await pushToSession({
        sessionId: target,
        runId: run.id,
        kind,
        findingIndex: kind === "finding" ? (activeFindingIndex ?? undefined) : undefined,
        message: kind === "question" ? draft.trim() : undefined,
        context:
          kind === "question" && activeFinding
            ? {
                file: activeFinding.file,
                line: activeFinding.line,
                finding: activeFinding.title,
              }
            : undefined,
      });
      setSent((prev) => [
        ...prev,
        {
          label: kind === "finding" ? activeFinding?.title ?? "finding" : draft.trim(),
          at: new Date().toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          }),
        },
      ]);
      if (kind === "question") setDraft("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const chosen = sessions.find((s) => s.sessionId === target) ?? null;

  return (
    <aside className="w-96 flex-shrink-0 border-l border-gray-800 flex flex-col bg-gray-950">
      <div className="px-3 py-2 border-b border-gray-800 flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-gray-500">
          Send to session
        </span>
        {sessions.length > 0 && (
          <span className="text-[10px] text-emerald-400/80 border border-emerald-500/30 rounded px-1">
            {sessions.length} listening
          </span>
        )}
        <button
          className="ml-auto text-xs text-gray-500 hover:text-gray-300"
          title="Hide this panel"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      {sessions.length === 0 && setup && <Setup setup={setup} />}

      {sessions.length > 0 && (
        <>
          <div className="px-3 py-2 border-b border-gray-800 space-y-1.5">
            {sessions.length > 1 && (
              <select
                className="w-full bg-gray-800 text-gray-300 text-xs border border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-blue-500"
                value={target ?? ""}
                onChange={(e) => setTarget(e.target.value)}
              >
                {sessions.map((s) => (
                  <option key={s.sessionId} value={s.sessionId}>
                    {s.label}
                    {s.matchesProject ? "" : " — different project"} ·{" "}
                    {s.sessionId.slice(0, 8)}
                  </option>
                ))}
              </select>
            )}
            {chosen && (
              <div
                className="text-[10px] text-gray-600 font-mono truncate"
                title={chosen.projectDir}
              >
                {chosen.projectDir}
              </div>
            )}
            {chosen && !chosen.matchesProject && (
              <div className="text-[11px] text-amber-300/90 leading-relaxed">
                That session is working in a different project than the one
                you're reviewing. It won't have this code checked out.
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
            <p className="text-xs text-gray-600 leading-relaxed">
              Pushes into that session as a{" "}
              <span className="font-mono text-gray-500">
                &lt;channel source="syl"&gt;
              </span>{" "}
              event. Read the reply where the session is running — this is a
              one-way channel.
            </p>

            {activeFinding && (
              <div className="rounded border border-gray-800 bg-gray-900 p-2 space-y-1.5">
                <div className="text-[10px] uppercase tracking-wide text-gray-600">
                  Selected finding
                </div>
                <div className="text-xs text-gray-200 leading-snug">
                  {activeFinding.title}
                </div>
                <div className="text-[11px] font-mono text-gray-600 truncate">
                  {activeFinding.file}:{activeFinding.line}
                </div>
                <button
                  className="text-[11px] px-2 py-1 rounded border border-blue-500/40 text-blue-300 hover:bg-blue-500/10 disabled:opacity-40"
                  disabled={busy || !target || activeFindingIndex === null}
                  onClick={() => void send("finding")}
                >
                  Send this finding
                </button>
              </div>
            )}

            {sent.map((entry, i) => (
              <div
                key={i}
                className="text-[11px] text-gray-500 border-l-2 border-emerald-500/40 pl-2"
              >
                <span className="text-gray-600">{entry.at}</span> sent{" "}
                <span className="text-gray-400">{entry.label}</span>
              </div>
            ))}
          </div>

          <div className="border-t border-gray-800 p-2 space-y-2">
            {error && (
              <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">
                {error}
              </div>
            )}
            <textarea
              className="w-full bg-gray-950 text-gray-200 border border-gray-700 rounded p-2 text-xs resize-y focus:outline-none focus:border-blue-500"
              rows={3}
              value={draft}
              placeholder="Ask your session about this pull request…"
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) {
                  e.preventDefault();
                  void send("question");
                }
              }}
            />
            <div className="flex items-center gap-2">
              <button
                className="px-2.5 py-1 text-[11px] rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:hover:bg-blue-600 text-white"
                disabled={!draft.trim() || busy || !target}
                onClick={() => void send("question")}
              >
                {busy ? "Sending…" : "Send"}
              </button>
              {activeFinding && (
                <span className="text-[10px] text-gray-600 truncate">
                  with {activeFinding.file}:{activeFinding.line}
                </span>
              )}
              <span className="text-[10px] text-gray-600 ml-auto">⌘↵</span>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
