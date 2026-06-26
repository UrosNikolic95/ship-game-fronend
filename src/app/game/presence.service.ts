import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';

// A live position for another player's ship. `x`/`y`/`heading` are the latest
// values pushed from the server; `rx`/`ry`/`rHeading` are the smoothed values
// the renderer interpolates toward each frame so other ships glide rather than
// teleport between the ~6/sec presence updates.
export interface OtherShip {
  id: string;
  name: string;
  x: number;
  y: number;
  heading: number;
  boatId: string;
  rx: number;
  ry: number;
  rHeading: number;
}

const SOCKET_URL = 'http://localhost:3000';

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
    // ties this socket to the same user as the REST API.
    this.socket = io(SOCKET_URL, { withCredentials: true });

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

  // Merge a server update into our map, preserving the smoothed render position
  // for ships we already know so they interpolate instead of snapping.
  private upsert(s: OtherShip): void {
    const existing = this.others.get(s.id);
    if (existing) {
      existing.x = s.x;
      existing.y = s.y;
      existing.heading = s.heading;
      existing.boatId = s.boatId;
      existing.name = s.name;
    } else {
      this.others.set(s.id, {
        ...s,
        rx: s.x,
        ry: s.y,
        rHeading: s.heading,
      });
    }
  }
}
