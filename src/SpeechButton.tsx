import { LoaderCircle, Square, Volume2 } from "lucide-react";
import type { PlaybackState } from "./useSpeechPlayback";
export default function SpeechButton({
  messageId,
  state,
  onPlay,
  onStop,
  disabled,
}: {
  messageId: string;
  state: PlaybackState;
  onPlay: () => void;
  onStop: () => void;
  disabled?: boolean;
}) {
  const active = state.messageId === messageId;
  return (
    <button
      type="button"
      className={`speech-button ${active ? "active" : ""}`}
      data-testid="speech-button"
      aria-label={active ? "停止朗读" : "朗读回复"}
      disabled={!active && disabled}
      title={
        active
          ? `停止朗读（${state.part}/${state.parts}）`
          : "朗读回复，代码块会跳过"
      }
      onClick={active ? onStop : onPlay}
    >
      {active ? (
        state.status === "loading" ? (
          <LoaderCircle size={15} className="spin" />
        ) : (
          <Square size={13} />
        )
      ) : (
        <Volume2 size={15} />
      )}
      {active && (
        <span>
          {state.status === "loading" ? "生成语音" : "正在朗读"}{" "}
          {state.parts > 1 ? `${state.part}/${state.parts}` : ""}
        </span>
      )}
    </button>
  );
}
