import { apiFetch } from "./api";
import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Mic, Square, X } from "lucide-react";
import { CLIENT_HEADERS } from "./multimodal";

type Phase = "idle" | "permission" | "recording" | "ready" | "transcribing";
interface Props {
  disabled?: boolean;
  onTranscript: (text: string) => void;
  onBusyChange: (value: boolean) => void;
}
export default function VoiceControls({
  disabled,
  onTranscript,
  onBusyChange,
}: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recording = useRef<Blob | null>(null);
  const url = useRef("");
  const request = useRef<AbortController | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const version = useRef(0);
  const latest = useRef({ onTranscript, onBusyChange });
  latest.current = { onTranscript, onBusyChange };
  const supported =
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia);
  function releaseRecording() {
    for (const timer of timers.current) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    timers.current = [];
    if (recorder.current?.state === "recording") recorder.current.stop();
    recorder.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }
  function dispose() {
    version.current++;
    request.current?.abort();
    request.current = null;
    releaseRecording();
    recording.current = null;
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = "";
  }
  function cancel() {
    dispose();
    setPhase("idle");
    setPreviewUrl("");
    setError("");
    setSeconds(0);
  }
  useEffect(() => {
    onBusyChange(["permission", "recording", "transcribing"].includes(phase));
  }, [phase, onBusyChange]);
  useEffect(
    () => () => {
      dispose();
      latest.current.onBusyChange(false);
    },
    [],
  );
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled]);
  function stopRecording() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }
  async function start() {
    if (disabled || !supported) return;
    dispose();
    setError("");
    setPreviewUrl("");
    setPhase("permission");
    setSeconds(0);
    const current = version.current;
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (current !== version.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const instance = new MediaRecorder(
        media,
        mimeType ? { mimeType } : undefined,
      );
      recorder.current = instance;
      const chunks: Blob[] = [];
      instance.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      instance.onerror = () => {
        if (current !== version.current) return;
        dispose();
        setPhase("idle");
        setError("录音设备发生错误，请检查麦克风后重试。");
      };
      instance.onstop = () => {
        if (current !== version.current) return;
        const blob = new Blob(chunks, {
          type: instance.mimeType || "audio/webm",
        });
        releaseRecording();
        if (!blob.size || blob.size > 6 * 1024 * 1024) {
          setPhase("idle");
          setError(
            blob.size
              ? "录音超过 6 MB，请缩短录音。"
              : "没有录到有效音频，请重试。",
          );
          return;
        }
        recording.current = blob;
        url.current = URL.createObjectURL(blob);
        setPreviewUrl(url.current);
        setPhase("ready");
      };
      instance.start(250);
      setPhase("recording");
      const started = Date.now();
      timers.current.push(
        setInterval(
          () =>
            setSeconds(Math.min(60, Math.floor((Date.now() - started) / 1000))),
          250,
        ),
      );
      timers.current.push(
        setTimeout(() => {
          setSeconds(60);
          stopRecording();
        }, 60_000),
      );
    } catch (cause) {
      if (current !== version.current) return;
      releaseRecording();
      setPhase("idle");
      setError(
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "麦克风权限未开启。请在浏览器地址栏允许麦克风后重试。"
          : "无法使用麦克风，请确认设备已连接且未被占用。",
      );
    }
  }
  async function transcribe() {
    if (disabled || !recording.current || phase === "transcribing") return;
    const current = version.current;
    const controller = new AbortController();
    request.current = controller;
    setPhase("transcribing");
    setError("");
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60_000);
    try {
      const blob = recording.current;
      const form = new FormData();
      form.append(
        "file",
        blob,
        blob.type.includes("mp4") ? "recording.m4a" : "recording.webm",
      );
      const response = await apiFetch("/api/audio/transcriptions", {
        method: "POST",
        headers: CLIENT_HEADERS,
        body: form,
        signal: controller.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : "语音转写失败，请重试。",
        );
      if (typeof result.text !== "string" || !result.text.trim())
        throw new Error("没有识别到文字，可以重新录制或重试。");
      if (current !== version.current || controller.signal.aborted) return;
      latest.current.onTranscript(result.text.trim());
      cancel();
    } catch (cause) {
      if (current !== version.current) return;
      setPhase("ready");
      setError(
        timedOut
          ? "语音转写超时，请重试。"
          : cause instanceof Error
            ? cause.message
            : "语音转写失败。",
      );
    } finally {
      clearTimeout(timer);
      if (request.current === controller) request.current = null;
    }
  }
  return (
    <div className="voice-controls">
      {phase === "idle" ? (
        <button
          type="button"
          className="media-action"
          aria-label="开始语音输入"
          disabled={disabled || !supported}
          title={
            supported
              ? "录音最长 60 秒，确认后转成文字"
              : "当前浏览器不支持麦克风录音"
          }
          onClick={() => void start()}
        >
          <Mic size={16} />
          语音输入
        </button>
      ) : (
        <div className="voice-active" data-testid="voice-recorder">
          {phase === "permission" ? (
            <span>
              <LoaderCircle size={14} className="spin" />
              正在请求麦克风…
            </span>
          ) : phase === "recording" ? (
            <>
              <span className="recording-dot" />
              <span>录音 {seconds} / 60 秒</span>
              <button
                type="button"
                aria-label="结束录音"
                onClick={stopRecording}
              >
                <Square size={12} />
                完成录音
              </button>
            </>
          ) : (
            <>
              <audio controls src={previewUrl} aria-label="录音预览" />
              <button
                type="button"
                aria-label="转成文字"
                disabled={disabled || phase === "transcribing"}
                onClick={() => void transcribe()}
              >
                {phase === "transcribing" ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <Check size={14} />
                )}
                {phase === "transcribing" ? "正在转写" : "转成文字"}
              </button>
            </>
          )}
          <button type="button" aria-label="取消语音输入" onClick={cancel}>
            <X size={14} />
          </button>
        </div>
      )}
      {error && (
        <p className="voice-error" role="alert">
          {error}
          <button
            type="button"
            aria-label="关闭录音错误"
            onClick={() => setError("")}
          >
            <X size={12} />
          </button>
        </p>
      )}
    </div>
  );
}
