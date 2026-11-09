// The silent video of the caption path's browser tests, made in the test (no media file in the
// repository). The overlay follows the position frame by frame (`requestVideoFrameCallback`),
// which needs real video frames: an audio-only source never presents one. Playwright's Chromium
// plays WebM (it has no H.264), so the test encodes one tiny VP8 key frame with WebCodecs in a
// page and repeats it in a WebM written here, every 100 ms, with a cue per cluster for seeking.
import type { BrowserContext, Page } from '@playwright/test';

/** One frame every 100 ms: the overlay can follow the position to within one frame. */
export const FRAME_MS = 100;
/** A cluster (and a seek point) every 10 s. */
const CLUSTER_MS = 10_000;
const SIZE = 16;

/**
 * A blank page of its own (WebCodecs needs a secure context, which `about:blank` is not; served
 * by the test on a host of its own, so the platform sees no request).
 */
const ENCODER_PAGE = 'https://video-encoder.test/';

/** One VP8 key frame of a dark 16×16 picture, encoded in a blank tab of `context`. */
async function keyFrame(context: BrowserContext): Promise<Buffer> {
  await context.route(ENCODER_PAGE, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>encoder</title>' }),
  );
  const page: Page = await context.newPage();
  await page.goto(ENCODER_PAGE);
  const bytes = await page.evaluate(async (size) => {
    const chunks: number[][] = [];
    let failed: string | undefined;
    const encoder = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push([...data]);
      },
      error: (error) => {
        failed = String(error);
      },
    });
    encoder.configure({ codec: 'vp8', width: size, height: size, bitrate: 10_000, framerate: 10 });
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d');
    if (context === null) return { failed: 'no 2d context', chunks };
    context.fillStyle = '#202020';
    context.fillRect(0, 0, size, size);
    const frame = new VideoFrame(canvas, { timestamp: 0 });
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    await encoder.flush();
    encoder.close();
    return { failed, chunks };
  }, SIZE);
  await page.close();
  await context.unroute(ENCODER_PAGE);
  const [chunk] = bytes.chunks;
  if (bytes.failed !== undefined || chunk === undefined)
    throw new Error(`VP8 encoding failed: ${bytes.failed ?? 'no chunk'}`);
  return Buffer.from(chunk);
}

/** An unsigned integer in `width` bytes, big endian. */
function uint(value: number, width = 8): Buffer {
  const bytes = Buffer.alloc(width);
  bytes.writeUIntBE(value, width - Math.min(width, 6), Math.min(width, 6));
  return bytes;
}
/** An EBML element: its ID, its size as an 8-byte number, its payload. */
function element(id: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  return Buffer.concat([Buffer.from(id, 'hex'), Buffer.from([0x01]), uint(body.length, 7), body]);
}
const text = (value: string): Buffer => Buffer.from(value, 'ascii');
function float(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value);
  return bytes;
}

/**
 * A silent WebM of `durationMs` (rounded up to a frame) showing one still frame every 100 ms,
 * every frame a key frame, so a seek lands anywhere. The frame is encoded in a tab of `context`.
 */
export async function silentVideo(context: BrowserContext, durationMs: number): Promise<Buffer> {
  const frame = await keyFrame(context);
  const frames = Math.ceil(durationMs / FRAME_MS);
  const header = element(
    '1a45dfa3',
    element('4286', uint(1, 1)),
    element('42f7', uint(1, 1)),
    element('42f2', uint(4, 1)),
    element('42f3', uint(8, 1)),
    element('4282', text('webm')),
    element('4287', uint(2, 1)),
    element('4285', uint(2, 1)),
  );
  const info = element(
    '1549a966',
    element('2ad7b1', uint(1_000_000, 3)),
    element('4489', float(frames * FRAME_MS)),
    element('4d80', text('fixture')),
    element('5741', text('fixture')),
  );
  const tracks = element(
    '1654ae6b',
    element(
      'ae',
      element('d7', uint(1, 1)),
      element('73c5', uint(1, 1)),
      element('83', uint(1, 1)),
      element('86', text('V_VP8')),
      element('e0', element('b0', uint(SIZE, 2)), element('ba', uint(SIZE, 2))),
    ),
  );
  const clusters: { time: number; bytes: Buffer }[] = [];
  const perCluster = CLUSTER_MS / FRAME_MS;
  for (let first = 0; first < frames; first += perCluster) {
    const blocks: Buffer[] = [];
    for (let index = first; index < Math.min(frames, first + perCluster); index += 1) {
      const relative = Buffer.alloc(2);
      relative.writeInt16BE((index - first) * FRAME_MS);
      // Track 1, the time from the cluster's, a key frame.
      blocks.push(element('a3', Buffer.from([0x81]), relative, Buffer.from([0x80]), frame));
    }
    const time = first * FRAME_MS;
    clusters.push({ time, bytes: element('1f43b675', element('e7', uint(time)), ...blocks) });
  }
  // Fixed-width numbers keep every cue point the same size, so the cues' size is known before
  // the cluster positions they hold (relative to the segment's payload) are.
  const cuePoint = (time: number, position: number): Buffer =>
    element(
      'bb',
      element('b3', uint(time)),
      element('b7', element('f7', uint(1, 1)), element('f1', uint(position))),
    );
  const cuesSize = element('1c53bb6b', ...clusters.map(() => cuePoint(0, 0))).length;
  let position = info.length + tracks.length + cuesSize;
  const points: Buffer[] = [];
  for (const cluster of clusters) {
    points.push(cuePoint(cluster.time, position));
    position += cluster.bytes.length;
  }
  const segment = element(
    '18538067',
    info,
    tracks,
    element('1c53bb6b', ...points),
    ...clusters.map((cluster) => cluster.bytes),
  );
  return Buffer.concat([header, segment]);
}
