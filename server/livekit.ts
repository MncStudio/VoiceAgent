import { AccessToken } from 'livekit-server-sdk';
import type { Config } from './config.js';
import type { Conversation } from './engine.js';
import { clientEventSchema } from '../shared/protocol.js';
export async function token(c: Config, room: string, identity: string) {
  const t = new AccessToken(c.LIVEKIT_API_KEY, c.LIVEKIT_API_SECRET, { identity, ttl: '10m' });
  t.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
  return t.toJwt();
}
export async function joinAgent(
  c: Config,
  roomName: string,
  clientIdentity: string,
  conversation: Conversation,
) {
  // Load native WebRTC only for a voice session; text mode runs without native media.
  const rtc = await import('@livekit/rtc-node');
  const room = new rtc.Room();
  const source = new rtc.AudioSource(24000, 1, 100);
  const streams = new Set<ReadableStreamDefaultReader<import('@livekit/rtc-node').AudioFrame>>();
  let closed = false,
    remainder = Buffer.alloc(0);
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const stream of streams) await stream.cancel();
    source.clearQueue();
    await source.close();
    await room.disconnect();
  };
  room.on(
    rtc.RoomEvent.DataReceived,
    (data: Uint8Array, participant: { identity: string } | undefined) => {
      if (participant?.identity !== clientIdentity) return;
      try {
        const event = clientEventSchema.safeParse(JSON.parse(Buffer.from(data).toString()));
        if (event.success) conversation.handle(event.data);
      } catch {}
    },
  );
  room.on(
    rtc.RoomEvent.TrackSubscribed,
    (
      track: import('@livekit/rtc-node').RemoteTrack,
      _publication: unknown,
      participant: { identity: string },
    ) => {
      if (participant.identity !== clientIdentity || track.kind !== rtc.TrackKind.KIND_AUDIO)
        return;
      const stream = new rtc.AudioStream(track, { sampleRate: 16000, numChannels: 1 }).getReader();
      streams.add(stream);
      void (async () => {
        try {
          for (;;) {
            const { value: frame, done } = await stream.read();
            if (closed || done) break;
            conversation.ingest(
              Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
            );
          }
        } catch {
          if (!closed) conversation.handle({ type: 'interrupt', reason: 'stop' });
        } finally {
          streams.delete(stream);
          await stream.cancel();
        }
      })();
    },
  );
  try {
    await room.connect(
      c.LIVEKIT_INTERNAL_URL,
      await token(c, roomName, `agent-${clientIdentity}`),
      { autoSubscribe: true, dynacast: false },
    );
    const track = rtc.LocalAudioTrack.createAudioTrack('chaobao-voice', source);
    const options = new rtc.TrackPublishOptions();
    options.source = rtc.TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant!.publishTrack(track, options);
    conversation.attachAudio({
      async write(pcm, signal) {
        const data = Buffer.concat([remainder, pcm]);
        const frameBytes = 480 * 2;
        let offset = 0;
        while (offset + frameBytes <= data.length) {
          signal.throwIfAborted();
          const copy = new Int16Array(480);
          for (let i = 0; i < 480; i++) copy[i] = data.readInt16LE(offset + i * 2);
          await source.captureFrame(new rtc.AudioFrame(copy, 24000, 1, 480));
          offset += frameBytes;
        }
        signal.throwIfAborted();
        remainder = Buffer.from(data.subarray(offset));
      },
      async drain() {
        if (remainder.length) {
          const copy = new Int16Array(480);
          for (let i = 0; i + 1 < remainder.length; i += 2) copy[i / 2] = remainder.readInt16LE(i);
          remainder = Buffer.alloc(0);
          await source.captureFrame(new rtc.AudioFrame(copy, 24000, 1, 480));
        }
        await source.waitForPlayout();
      },
      clear() {
        remainder = Buffer.alloc(0);
        source.clearQueue();
      },
    });
    return { room, close };
  } catch (error) {
    await close();
    throw error;
  }
}
