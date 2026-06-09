// ABOUTME: ScriptProcessor capture helpers for WebViews where zero-gain graphs can stop pulling.
// ABOUTME: Keeps mic capture audible-output-free while forcing the processor to render.

export function silenceScriptProcessorOutput(
  event: AudioProcessingEvent,
): void {
  for (
    let channel = 0;
    channel < event.outputBuffer.numberOfChannels;
    channel += 1
  ) {
    event.outputBuffer.getChannelData(channel).fill(0);
  }
}

export function connectPulledScriptProcessor(
  context: AudioContext,
  source: AudioNode,
  onProcess: (event: AudioProcessingEvent) => void,
): ScriptProcessorNode {
  const processor = context.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    silenceScriptProcessorOutput(event);
    onProcess(event);
  };
  source.connect(processor);
  processor.connect(context.destination);
  return processor;
}
