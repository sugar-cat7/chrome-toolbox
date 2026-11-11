import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { createPcmPipeline } from '../audio/pcm-pipeline.ts';

// Names of the AudioWorkletGlobalScope, which the DOM library lacks. Declared in this module only,
// so no other file sees them as globals.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

/**
 * The `st-pcm` processor, loaded with `audioWorklet.addModule('/pcm-worklet.js')`. The
 * AudioContext stays at the device rate so the viewer hears the tab unchanged; this turns its
 * input into 16 kHz speech segments (`PcmSegmentMessage`) and takes `{ type: 'flush' }` and
 * `{ type: 'reset' }` (`PcmCommand`). It runs in the AudioWorkletGlobalScope, so it imports no
 * extension API.
 */
export default defineUnlistedScript(() => {
  class PcmProcessor extends AudioWorkletProcessor {
    readonly #pipeline = createPcmPipeline(sampleRate, (message, transfer) =>
      this.port.postMessage(message, transfer),
    );

    constructor() {
      super();
      this.port.onmessage = (event: MessageEvent<unknown>) => this.#pipeline.command(event.data);
    }

    /** Called for each 128-frame render block; true keeps the processor alive without input. */
    process(inputs: readonly (readonly Float32Array[])[]): boolean {
      this.#pipeline.process(inputs[0] ?? []);
      return true;
    }
  }
  registerProcessor('st-pcm', PcmProcessor);
});
