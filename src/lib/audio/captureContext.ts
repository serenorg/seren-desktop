// ABOUTME: Creates a running Web Audio context for webview microphone capture.
// ABOUTME: Resumes the context so a suspended-by-default WKWebView can't silently capture nothing.

/**
 * Create an `AudioContext` and guarantee it is actually running. When
 * `sampleRate` is omitted, the WebView picks the hardware rate.
 *
 * WKWebView/Safari — and any context created outside a user gesture — start an
 * `AudioContext` in the `suspended` state. While suspended a `ScriptProcessor`'s
 * `onaudioprocess` never fires, so microphone capture silently produces no PCM
 * (the meeting/dictation "records nothing then fails" bug). Resume the context
 * and fail loudly if it cannot run, rather than record silence.
 */
export async function createRunningAudioContext(
  sampleRate?: number,
): Promise<AudioContext> {
  const context =
    sampleRate === undefined
      ? new AudioContext()
      : new AudioContext({ sampleRate });
  await context.resume();
  if (context.state !== "running") {
    await context.close().catch(() => {});
    throw new Error(
      "Audio capture could not start: the audio context is suspended.",
    );
  }
  return context;
}
