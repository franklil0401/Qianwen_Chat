import { apiFetch } from "./api";
import { useCallback, useEffect, useRef, useState } from "react";
import { CLIENT_HEADERS, speechSegments } from "./multimodal";

export interface PlaybackState {
  messageId: string | null;
  status: "idle" | "loading" | "playing";
  part: number;
  parts: number;
}
export function useSpeechPlayback(
  scopeKey: string,
  onError: (message: string) => void,
) {
  const [state, setState] = useState<PlaybackState>({
    messageId: null,
    status: "idle",
    part: 0,
    parts: 0,
  });
  const request = useRef<AbortController | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  const version = useRef(0);
  const stop = useCallback(() => {
    version.current++;
    request.current?.abort();
    request.current = null;
    if (player.current) {
      player.current.pause();
      player.current.removeAttribute("src");
      player.current = null;
    }
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
    setState({ messageId: null, status: "idle", part: 0, parts: 0 });
  }, []);
  useEffect(() => {
    stop();
    return stop;
  }, [scopeKey, stop]);
  async function play(messageId: string, text: string) {
    stop();
    const segments = speechSegments(text);
    if (!segments.length) {
      onError("这条回复没有可朗读的文字。");
      return;
    }
    const current = version.current;
    const controller = new AbortController();
    request.current = controller;
    try {
      for (let index = 0; index < segments.length; index++) {
        controller.signal.throwIfAborted();
        setState({
          messageId,
          status: "loading",
          part: index + 1,
          parts: segments.length,
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, 60_000);
        let blob: Blob;
        try {
          const response = await apiFetch("/api/audio/speech", {
            method: "POST",
            headers: { ...CLIENT_HEADERS, "Content-Type": "application/json" },
            body: JSON.stringify({ text: segments[index] }),
            signal: controller.signal,
          });
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(
              typeof error.error === "string"
                ? error.error
                : "语音生成失败，请重试。",
            );
          }
          blob = await response.blob();
        } catch (error) {
          if (timedOut) throw new Error("语音生成超时，请稍后再试。");
          throw error;
        } finally {
          clearTimeout(timer);
        }
        controller.signal.throwIfAborted();
        if (!blob.size || !blob.type.startsWith("audio/"))
          throw new Error("没有收到有效的语音数据。");
        const url = URL.createObjectURL(blob);
        objectUrl.current = url;
        const audio = new Audio(url);
        player.current = audio;
        setState({
          messageId,
          status: "playing",
          part: index + 1,
          parts: segments.length,
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              controller.signal.removeEventListener("abort", cancel);
              audio.onended = null;
              audio.onerror = null;
            };
            const cancel = () => {
              cleanup();
              audio.pause();
              reject(new DOMException("Stopped", "AbortError"));
            };
            audio.onended = () => {
              cleanup();
              resolve();
            };
            audio.onerror = () => {
              cleanup();
              reject(new Error("音频播放失败，请重试。"));
            };
            controller.signal.addEventListener("abort", cancel, { once: true });
            void audio.play().catch(() => {
              cleanup();
              reject(new Error("浏览器未能播放音频，请再次点击朗读。"));
            });
          });
        } finally {
          audio.pause();
          audio.removeAttribute("src");
          URL.revokeObjectURL(url);
          if (player.current === audio) player.current = null;
          if (objectUrl.current === url) objectUrl.current = null;
        }
      }
    } catch (error) {
      if (
        version.current === current &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        onError(error instanceof Error ? error.message : "朗读暂时不可用。");
    } finally {
      if (version.current === current) {
        request.current = null;
        setState({ messageId: null, status: "idle", part: 0, parts: 0 });
      }
    }
  }
  return { state, play, stop };
}
