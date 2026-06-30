import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../environments/environment';

// A live position for another player's ship. `x`/`y`/`heading` are the latest
// values pushed from the server; `rx`/`ry`/`rHeading` are the smoothed values
// the renderer draws. Rather than easing toward the latest value (which lags and
// stutters), we keep a short `buffer` of timestamped server samples and play it
// back a fixed delay behind real time, interpolating along the actual path — see
// interpolate(). This gives steady, constant-velocity gliding between the
// ~8/sec presence updates instead of teleporting.
export interface OtherShip {
  id: string;
  name: string;
  boatId: string;
  // Latest raw values pushed from the server.
  x: number;
  y: number;
  heading: number;
  // Smoothed values the renderer draws, produced by interpolate() each frame.
  rx: number;
  ry: number;
  rHeading: number;
  // Recent server positions, oldest first, used to reconstruct a smooth path.
  buffer: Sample[];
}

// One timestamped server position. `t` is the local arrival time (performance
// clock); without a synced server clock, arrival time is what we interpolate
// against, and the render delay absorbs the jitter.
interface Sample {
  t: number;
  x: number;
  y: number;
  heading: number;
}

const SOCKET_URL = environment.socketUrl;

// How far behind real time to render other ships. Presence updates arrive about
// every 120ms, so staying ~150ms in the past means we almost always have a
// sample on both sides of the render time to interpolate between, trading a
// sliver of latency for smooth motion.
const RENDER_DELAY = 150;
// When an update is late and the render time outruns our newest sample, dead
// reckon along the last known velocity — but only this far, so a ship that has
// actually stopped doesn't keep drifting.
const MAX_EXTRAPOLATION = 250;
// How much position history to retain per ship.
const BUFFER_WINDOW = 1000;

// Real-time presence over Socket.IO: streams this player's ship position to the
// server and tracks every other player's ship so the game can draw them moving.
@Injectable({ providedIn: 'root' })
export class PresenceService {
  private socket?: Socket;
  // Other players' ships, keyed by their user id. Read directly by the canvas
  // render loop, so it's a plain Map (no Angular change detection needed).
  private readonly others = new Map<string, OtherShip>();

  connect(): void {
    if (this.socket) return;
    // withCredentials sends the session cookie in the handshake, so the server
    // ties this socket to the same user as the REST API. `path` must match the
    // gateway's `/api/socket.io` so the connection rides the same `/api` route
    // nginx proxies to the backend in production (see game.gateway.ts).
    this.socket = io(SOCKET_URL, {
      path: '/api/socket.io',
      withCredentials: true,
    });

    this.socket.on('presence:snapshot', (ships: OtherShip[]) => {
      this.others.clear();
      for (const s of ships) this.upsert(s);
    });
    this.socket.on('presence:update', (s: OtherShip) => this.upsert(s));
    this.socket.on('presence:leave', ({ id }: { id: string }) =>
      this.others.delete(id),
    );
    // On a dropped connection, forget everyone; a fresh snapshot arrives on
    // reconnect.
    this.socket.on('disconnect', () => this.others.clear());
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = undefined;
    this.others.clear();
  }

  // Push this player's current ship position to the server.
  move(x: number, y: number, heading: number, boatId: string): void {
    this.socket?.emit('presence:move', { x, y, heading, boatId });
  }

  // The live map of other ships, for the renderer to read each frame.
  getOthers(): Map<string, OtherShip> {
    return this.others;
  }

  // Advance every other ship's smoothed render position to `now`. Call once per
  // frame before drawing. Each ship is placed RENDER_DELAY in the past and
  // linearly interpolated between the two buffered samples that straddle that
  // time, so motion is smooth and frame-rate independent.
  interpolate(now: number): void {
    const renderTime = now - RENDER_DELAY;
    for (const o of this.others.values()) {
      const buf = o.buffer;
      if (buf.length === 0) continue;

      // Render time predates our history — hold at the oldest known position.
      if (renderTime <= buf[0].t) {
        o.rx = buf[0].x;
        o.ry = buf[0].y;
        o.rHeading = buf[0].heading;
        continue;
      }

      // Find the latest sample at or before the render time.
      let i = buf.length - 1;
      while (i > 0 && buf[i].t > renderTime) i--;

      if (i < buf.length - 1) {
        // Common case: interpolate between the two straddling samples.
        const a = buf[i];
        const b = buf[i + 1];
        const span = b.t - a.t;
        const t = span > 0 ? (renderTime - a.t) / span : 0;
        o.rx = a.x + (b.x - a.x) * t;
        o.ry = a.y + (b.y - a.y) * t;
        o.rHeading = lerpAngle(a.heading, b.heading, t);
      } else {
        // Outrun the buffer (a late or dropped update): briefly dead reckon
        // along the last segment's velocity, capped so a stopped ship settles.
        const last = buf[i];
        const prev = buf[i - 1];
        if (prev && last.t > prev.t) {
          const ahead = Math.min(renderTime - last.t, MAX_EXTRAPOLATION);
          const dt = last.t - prev.t;
          o.rx = last.x + ((last.x - prev.x) / dt) * ahead;
          o.ry = last.y + ((last.y - prev.y) / dt) * ahead;
        } else {
          o.rx = last.x;
          o.ry = last.y;
        }
        o.rHeading = last.heading;
      }
    }
  }

  // Merge a server update into our map, appending a timestamped sample so the
  // renderer can interpolate. Existing ships keep their buffer (and thus their
  // smooth path); new ships start parked at their first reported position.
  private upsert(s: OtherShip): void {
    const now = performance.now();
    const existing = this.others.get(s.id);
    if (existing) {
      existing.x = s.x;
      existing.y = s.y;
      existing.heading = s.heading;
      existing.boatId = s.boatId;
      existing.name = s.name;
      this.pushSample(existing, now);
    } else {
      const ship: OtherShip = {
        id: s.id,
        name: s.name,
        boatId: s.boatId,
        x: s.x,
        y: s.y,
        heading: s.heading,
        rx: s.x,
        ry: s.y,
        rHeading: s.heading,
        buffer: [],
      };
      this.pushSample(ship, now);
      this.others.set(s.id, ship);
    }
  }

  // Record the ship's current position as a sample and drop stale history,
  // always keeping at least two samples so interpolation has a segment to work
  // with.
  private pushSample(o: OtherShip, t: number): void {
    o.buffer.push({ t, x: o.x, y: o.y, heading: o.heading });
    const cutoff = t - BUFFER_WINDOW;
    while (o.buffer.length > 2 && o.buffer[0].t < cutoff) o.buffer.shift();
  }
}

// Interpolate between two angles along the shortest arc (handles wraparound).
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
