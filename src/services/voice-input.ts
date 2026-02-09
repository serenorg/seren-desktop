// ABOUTME: Voice input service for capturing audio and routing to STT publishers.
// ABOUTME: Manages microphone access, recording lifecycle, and publisher selection.

export type STTPublisher = "deepgram" | "assemblyai" | "openai-whisper";

export interface VoiceInputConfig {
  publisher: STTPublisher;
  language?: string;
}

export interface TranscriptionResult {
  text: string;
  confidence: number;
  durationMs: number;
}

// TODO: Implement microphone capture via navigator.mediaDevices.getUserMedia()
// TODO: Implement MediaRecorder for audio chunking
// TODO: Route audio to selected STT publisher via Gateway
// TODO: Return transcribed text for insertion into chat input
