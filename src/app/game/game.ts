import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  AfterViewInit,
  inject,
  signal,
  computed,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { GameService } from './game.service';
import {
  GameState,
  Port,
  Resource,
  RESOURCES,
  DOCK_RADIUS,
  buyPrice,
  sellPrice,
} from './models';

@Component({
  selector: 'app-game',
  imports: [DecimalPipe],
  templateUrl: './game.html',
  styleUrl: './game.css',
})
export class Game implements AfterViewInit, OnDestroy {
  private readonly api = inject(GameService);
  private readonly canvasRef =
    viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  readonly resources = RESOURCES;

  // Authoritative economy state from the backend (gold, cargo, ports, world).
  readonly state = signal<GameState | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  // Port the ship is currently docked at, if any. Drives the trade panel.
  readonly nearbyPort = signal<Port | null>(null);
  // Live ship coordinates for the HUD (updated a few times per second).
  readonly shipPos = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  // Quantity selected in the trade panel.
  readonly tradeQty = signal(1);
  // Whether the full-world map overlay is open.
  readonly showMap = signal(false);

  readonly cargoUsed = computed(() => {
    const s = this.state();
    if (!s) return 0;
    return RESOURCES.reduce((sum, r) => sum + s.ship.cargo[r], 0);
  });

  // ---- movement (kept in plain fields so the render loop never triggers CD)
  private shipX = 0;
  private shipY = 0;
  private vx = 0;
  private vy = 0;
  private heading = -Math.PI / 2;
  private readonly keys = new Set<string>();

  private ctx!: CanvasRenderingContext2D;
  private rafId = 0;
  private lastTime = 0;
  private lastSync = 0;
  private lastSyncedPos = { x: 0, y: 0 };
  private hudAccum = 0;

  // Tuning for the arcade-style sailing feel.
  private readonly ACCEL = 0.45;
  private readonly FRICTION = 0.94; // per 60fps frame
  private readonly MAX_SPEED = 6;

  ngAfterViewInit(): void {
    const canvas = this.canvasRef().nativeElement;
    this.ctx = canvas.getContext('2d')!;
    this.resizeCanvas();
    this.loadState();
    this.rafId = requestAnimationFrame((t) => this.loop(t));
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
  }

  private loadState(): void {
    this.api.getState().subscribe({
      next: (s) => {
        this.applyState(s);
        this.shipX = s.ship.x;
        this.shipY = s.ship.y;
        this.lastSyncedPos = { x: s.ship.x, y: s.ship.y };
        this.shipPos.set({ x: Math.round(s.ship.x), y: Math.round(s.ship.y) });
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set('Cannot reach game server on http://localhost:3000');
        this.loading.set(false);
        console.error(e);
      },
    });
  }

  private applyState(s: GameState): void {
    this.state.set(s);
  }

  // ---- input ---------------------------------------------------------------

  @HostListener('window:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    const k = e.key.toLowerCase();
    if (k === 'm') {
      this.toggleMap();
      return;
    }
    if (MOVE_KEYS.has(k)) {
      this.keys.add(k);
      e.preventDefault();
    }
  }

  toggleMap(): void {
    this.showMap.update((v) => !v);
  }

  @HostListener('window:keyup', ['$event'])
  onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.key.toLowerCase());
  }

  @HostListener('window:resize')
  onResize(): void {
    this.resizeCanvas();
  }

  private resizeCanvas(): void {
    const canvas = this.canvasRef().nativeElement;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  // ---- game loop -----------------------------------------------------------

  private loop(now: number): void {
    const dt = this.lastTime ? Math.min((now - this.lastTime) / 16.67, 3) : 1;
    this.lastTime = now;

    this.updateMovement(dt);
    this.updateDocking();
    this.updateHud(dt, now);
    this.syncPosition(now);
    this.render();

    this.rafId = requestAnimationFrame((t) => this.loop(t));
  }

  private updateMovement(dt: number): void {
    const s = this.state();
    if (!s) return;

    let ax = 0;
    let ay = 0;
    if (this.keys.has('arrowup') || this.keys.has('w')) ay -= 1;
    if (this.keys.has('arrowdown') || this.keys.has('s')) ay += 1;
    if (this.keys.has('arrowleft') || this.keys.has('a')) ax -= 1;
    if (this.keys.has('arrowright') || this.keys.has('d')) ax += 1;

    if (ax !== 0 || ay !== 0) {
      const len = Math.hypot(ax, ay);
      this.vx += (ax / len) * this.ACCEL * dt;
      this.vy += (ay / len) * this.ACCEL * dt;
    }

    // Friction and speed cap.
    const fr = Math.pow(this.FRICTION, dt);
    this.vx *= fr;
    this.vy *= fr;
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > this.MAX_SPEED) {
      this.vx = (this.vx / speed) * this.MAX_SPEED;
      this.vy = (this.vy / speed) * this.MAX_SPEED;
    }

    this.shipX = clamp(this.shipX + this.vx * dt, 0, s.world.width);
    this.shipY = clamp(this.shipY + this.vy * dt, 0, s.world.height);

    if (speed > 0.1) this.heading = Math.atan2(this.vy, this.vx);
  }

  private updateDocking(): void {
    const s = this.state();
    if (!s) return;
    let docked: Port | null = null;
    for (const p of s.ports) {
      if (Math.hypot(this.shipX - p.x, this.shipY - p.y) <= DOCK_RADIUS) {
        docked = p;
        break;
      }
    }
    const current = this.nearbyPort();
    if (docked?.id !== current?.id) {
      this.nearbyPort.set(docked);
      // Persist position on docking so server-side trade validation agrees.
      if (docked) this.pushPosition();
    }
  }

  private updateHud(dt: number, now: number): void {
    this.hudAccum += dt;
    if (this.hudAccum >= 12) {
      this.hudAccum = 0;
      this.shipPos.set({ x: Math.round(this.shipX), y: Math.round(this.shipY) });
    }
  }

  private syncPosition(now: number): void {
    if (now - this.lastSync < 1000) return;
    this.lastSync = now;
    const moved =
      Math.abs(this.shipX - this.lastSyncedPos.x) > 1 ||
      Math.abs(this.shipY - this.lastSyncedPos.y) > 1;
    if (moved) this.pushPosition();
  }

  private pushPosition(): void {
    this.lastSyncedPos = { x: this.shipX, y: this.shipY };
    this.api.move(this.shipX, this.shipY).subscribe({ error: () => {} });
  }

  // ---- trading -------------------------------------------------------------

  buy(resource: Resource): void {
    this.doTrade(resource, 'buy');
  }

  sell(resource: Resource): void {
    this.doTrade(resource, 'sell');
  }

  private doTrade(resource: Resource, action: 'buy' | 'sell'): void {
    const port = this.nearbyPort();
    if (!port) return;
    const qty = this.tradeQty();
    this.error.set(null);
    this.api.trade(port.id, resource, qty, action).subscribe({
      next: (s) => this.applyState(s),
      error: (e) => {
        this.error.set(e?.error?.message ?? 'Trade failed');
        setTimeout(() => this.error.set(null), 2500);
      },
    });
  }

  setQty(q: number): void {
    this.tradeQty.set(Math.max(1, Math.min(50, Math.round(q))));
  }

  resetGame(): void {
    this.api.reset().subscribe((s) => {
      this.applyState(s);
      this.shipX = s.ship.x;
      this.shipY = s.ship.y;
      this.vx = this.vy = 0;
      this.nearbyPort.set(null);
      this.shipPos.set({ x: Math.round(s.ship.x), y: Math.round(s.ship.y) });
    });
  }

  // Average gold paid per unit for a resource across all purchases so far.
  avgCostOf(r: Resource): number {
    const stats = this.state()?.purchases.perResource[r];
    if (!stats || stats.qty === 0) return 0;
    return stats.spent / stats.qty;
  }

  // Price helpers for the template.
  buyPriceOf(port: Port, r: Resource): number {
    return buyPrice(port.prices[r]);
  }
  sellPriceOf(port: Port, r: Resource): number {
    return sellPrice(port.prices[r]);
  }

  // ---- rendering -----------------------------------------------------------

  private render(): void {
    const ctx = this.ctx;
    const s = this.state();
    const canvas = this.canvasRef().nativeElement;
    const W = canvas.width;
    const H = canvas.height;

    // Sea.
    ctx.fillStyle = '#14222e';
    ctx.fillRect(0, 0, W, H);
    if (!s) return;

    const camX = this.shipX - W / 2;
    const camY = this.shipY - H / 2;

    this.drawGrid(ctx, camX, camY, W, H);
    this.drawWorldBorder(ctx, camX, camY, s);

    for (const p of s.ports) {
      this.drawPort(ctx, p, camX, camY, p.id === this.nearbyPort()?.id);
    }

    this.drawShip(ctx, W / 2, H / 2);

    if (this.showMap()) this.drawMap(ctx, s, W, H);
  }

  // Full-world overview: the entire map scaled to fit the screen.
  private drawMap(
    ctx: CanvasRenderingContext2D,
    s: GameState,
    W: number,
    H: number,
  ): void {
    // Dim the game behind the map.
    ctx.fillStyle = 'rgba(8, 14, 19, 0.78)';
    ctx.fillRect(0, 0, W, H);

    // Square panel that fits the (square) world into the viewport.
    const size = Math.min(W, H) * 0.8;
    const ox = (W - size) / 2;
    const oy = (H - size) / 2;
    const scale = size / s.world.width;

    // Panel background + border.
    ctx.fillStyle = '#14222e';
    ctx.fillRect(ox, oy, size, size);
    ctx.strokeStyle = 'rgba(127,209,185,0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(ox, oy, size, size);

    // Title.
    ctx.fillStyle = '#7fd1b9';
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('World Map', ox, oy - 12);
    ctx.fillStyle = 'rgba(223,231,234,0.5)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('press M or Map to close', ox + size, oy - 12);

    // Ports.
    for (const p of s.ports) {
      const px = ox + p.x * scale;
      const py = oy + p.y * scale;
      ctx.fillStyle = '#e0c068';
      ctx.fillRect(px - 4, py - 4, 8, 8);
      ctx.fillStyle = '#dfe7ea';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(p.name, px, py - 8);
    }

    // Ship marker.
    const sx = ox + this.shipX * scale;
    const sy = oy + this.shipY * scale;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(this.heading);
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(-5, -4);
    ctx.lineTo(-5, 4);
    ctx.closePath();
    ctx.fillStyle = '#f2f2f2';
    ctx.fill();
    ctx.restore();
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    camX: number,
    camY: number,
    W: number,
    H: number,
  ): void {
    const step = 200;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    const startX = -((camX % step) + step) % step;
    const startY = -((camY % step) + step) % step;
    ctx.beginPath();
    for (let x = startX; x < W; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    for (let y = startY; y < H; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
  }

  private drawWorldBorder(
    ctx: CanvasRenderingContext2D,
    camX: number,
    camY: number,
    s: GameState,
  ): void {
    ctx.strokeStyle = 'rgba(127,209,185,0.25)';
    ctx.lineWidth = 3;
    ctx.strokeRect(-camX, -camY, s.world.width, s.world.height);
  }

  private drawPort(
    ctx: CanvasRenderingContext2D,
    p: Port,
    camX: number,
    camY: number,
    active: boolean,
  ): void {
    const x = p.x - camX;
    const y = p.y - camY;

    // Dock radius ring.
    ctx.beginPath();
    ctx.arc(x, y, DOCK_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = active
      ? 'rgba(127,209,185,0.6)'
      : 'rgba(224,192,104,0.18)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Landmass blob.
    ctx.beginPath();
    ctx.arc(x, y, 26, 0, Math.PI * 2);
    ctx.fillStyle = '#2c3e2c';
    ctx.fill();

    // Port marker (square = a quay).
    ctx.fillStyle = active ? '#7fd1b9' : '#e0c068';
    ctx.fillRect(x - 8, y - 8, 16, 16);

    // Label.
    ctx.fillStyle = '#dfe7ea';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, x, y - 34);
  }

  private drawShip(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.heading);

    // Hull as a pointed triangle.
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-10, -8);
    ctx.lineTo(-6, 0);
    ctx.lineTo(-10, 8);
    ctx.closePath();
    ctx.fillStyle = '#f2f2f2';
    ctx.fill();
    ctx.strokeStyle = '#9aa7ad';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();
  }
}

const MOVE_KEYS = new Set([
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'w',
  'a',
  's',
  'd',
]);

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
