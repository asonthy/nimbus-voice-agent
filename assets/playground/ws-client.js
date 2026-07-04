/**
 * WebSocket voice session manager.
 * Handles mic → MediaRecorder → WS → ASR/LLM/TTS pipeline.
 */

import { VAD } from "./vad.js";
import { dispatch } from "./tools.js";

export class WsSession {
  constructor({
    backendUrl,
    config,
    onStateChange,
    onTranscript,
    onToken,
    onTurnDone,
    onToolCall,
    catalog,
  }) {
    this._url = (backendUrl || "http://localhost:8000")
      .replace("http://", "ws://")
      .replace("https://", "wss://") + "/api/ws";
    this._config = config;
    this._cb = { onStateChange, onTranscript, onToken, onTurnDone, onToolCall };
    this._ws = null;
    this._stream = null;
    this._recorder = null;
    this._vad = null;
    this.listening = false;
    this._ttsSource = null;
    this._audioCtx = null;
    this._ttsPlaying = false;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this._url);
      this._ws.onopen = () => {
        this._ws.send(JSON.stringify({ type: "config", data: this._config }));
        resolve();
      };
      this._ws.onerror = reject;
      this._ws.onmessage = (e) => this._onMessage(JSON.parse(e.data));
    });
  }

  async startListening() {
    if (this.listening) return;
    this.listening = true;
    this._cb.onStateChange?.("listening");

    this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this._recorder = new MediaRecorder(this._stream, { mimeType: "audio/webm;codecs=opus" });

    this._recorder.ondataavailable = async (e) => {
      if (e.data.size === 0) return;
      const b64 = await _blobToB64(e.data);
      this._ws?.send(JSON.stringify({ type: "audio_chunk", data: b64.split(",")[1] }));
    };
    this._recorder.start(200);

    this._vad = new VAD({
      endpointMs: this._config.vadEndpointMs || 500,
      sensitivity: this._config.vadSensitivity || 0.015,
    });

    this._vad.addEventListener("voice_start", () => {
      if (this._ttsPlaying) {
        this._interruptTts();
        this._ws?.send(JSON.stringify({ type: "interrupt" }));
      }
    });

    this._vad.addEventListener("voice_end", () => {
      this._ws?.send(JSON.stringify({ type: "vad_end" }));
    });

    await this._vad.start(this._stream);
  }

  stopListening() {
    this.listening = false;
    this._vad?.stop();
    this._recorder?.stop();
    this._stream?.getTracks().forEach((t) => t.stop());
    this._stream = null;
    this._cb.onStateChange?.("idle");
  }

  _interruptTts() {
    this._ttsSource?.stop();
    this._ttsSource = null;
    this._ttsPlaying = false;
  }

  _onMessage(msg) {
    switch (msg.type) {
      case "asr_partial":
        this._cb.onTranscript?.(msg.text, false);
        break;

      case "asr_final":
        this._cb.onTranscript?.(msg.text, true);
        this._cb.onStateChange?.("thinking");
        break;

      case "llm_token":
        this._cb.onToken?.(msg.text);
        break;

      case "llm_done":
        this._cb.onStateChange?.("speaking");
        break;

      case "tool_call":
        this._handleToolCall(msg.data);
        break;

      case "tts_chunk":
        this._playTtsChunk(msg.audio_b64);
        break;

      case "tts_done":
        this._ttsPlaying = false;
        this._cb.onStateChange?.("idle");
        break;

      case "latency_report":
        this._cb.onTurnDone?.(msg.breakdown);
        break;

      case "interrupted":
        this._cb.onStateChange?.("listening");
        break;

      case "error":
        console.error("WS error:", msg.message);
        this._cb.onStateChange?.("idle");
        break;
    }
  }

  async _handleToolCall(tc) {
    const { result, latency_ms } = await dispatch(tc.name, tc.args || {});
    this._cb.onToolCall?.(tc.name, result);
    this._ws?.send(JSON.stringify({
      type: "tool_result",
      data: { id: tc.id || tc.name, name: tc.name, result },
    }));
  }

  async _playTtsChunk(b64) {
    if (!this._audioCtx) {
      this._audioCtx = new AudioContext();
    }
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const buf = await this._audioCtx.decodeAudioData(bytes.buffer);
      const source = this._audioCtx.createBufferSource();
      source.buffer = buf;
      source.connect(this._audioCtx.destination);
      this._ttsSource = source;
      this._ttsPlaying = true;
      source.start(0);
      source.onended = () => {
        this._ttsPlaying = false;
        this._ttsSource = null;
      };
    } catch (err) {
      console.error("TTS playback error:", err);
    }
  }
}

function _blobToB64(blob) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result);
    reader.onerror = rej;
    reader.readAsDataURL(blob);
  });
}
