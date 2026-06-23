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
  Inventory,
  Port,
  Resource,
  RESOURCES,
  DOCK_RADIUS,
  Boat,
  BOATS,
  findBoat,
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
  // The two legs of a route, used to render the planner. Leg 1 sails port 1 →
  // port 2; leg 2 is the return trip port 2 → port 1.
  readonly legNumbers = [1, 2] as const;

  // Authoritative economy state from the backend (gold, cargo, ports, world).
  readonly state = signal<GameState | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  // Port the ship is currently docked at, if any. Drives the trade panel.
  readonly nearbyPort = signal<Port | null>(null);
  // Live ship coordinates for the HUD (updated a few times per second).
  readonly shipPos = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  // Quantity selected in the trade panel, chosen from preset options.
  readonly tradeQuantity = signal(1);
  readonly quantityOptions = [1, 5, 10, 50];
  // Whether the full-world map overlay is open.
  readonly showMap = signal(false);

  // Route planner: two ports picked on the map. The route is a round trip with
  // two legs — port 1 → port 2 (leg 1) and port 2 → port 1 (leg 2) — each of
  // which buys goods at its origin and sells them at its destination, so the
  // player can profit in both directions.
  readonly portAId = signal<string | null>(null);
  readonly portBId = signal<string | null>(null);
  readonly portA = computed(
    () => this.state()?.ports.find((p) => p.id === this.portAId()) ?? null,
  );
  readonly portB = computed(
    () => this.state()?.ports.find((p) => p.id === this.portBId()) ?? null,
  );

  // Quantity of each good to trade on each leg of the route.
  readonly leg1Quantities = signal<Inventory>(emptyInventory());
  readonly leg2Quantities = signal<Inventory>(emptyInventory());

  // Whether the autopilot should keep looping the round trip until cancelled.
  readonly routeRepeat = signal(false);

  readonly routeTotalQuantity = computed(
    () => this.legTotalQuantity(1) + this.legTotalQuantity(2),
  );

  // The ordered legs the autopilot will actually run — a leg is skipped when it
  // has nothing to carry. Each leg buys at one port and sells at the other.
  readonly routeLegs = computed<RouteLeg[]>(() => {
    const a = this.portA();
    const b = this.portB();
    if (!a || !b) return [];
    const legs: RouteLeg[] = [];
    if (this.legTotalQuantity(1) > 0) {
      legs.push({ buyPortId: a.id, sellPortId: b.id, quantities: { ...this.leg1Quantities() } });
    }
    if (this.legTotalQuantity(2) > 0) {
      legs.push({ buyPortId: b.id, sellPortId: a.id, quantities: { ...this.leg2Quantities() } });
    }
    return legs;
  });

  // Why the route trade can't start, or null when it's good to go. Validates the
  // first leg that will run (its buy must fit current cargo space and gold);
  // later legs are checked by the backend as the voyage unfolds.
  readonly routeTradeBlock = computed<string | null>(() => {
    const s = this.state();
    const first = this.routeLegs()[0];
    if (!s || !first) return null;

    const port = s.ports.find((p) => p.id === first.buyPortId);
    if (!port) return null;
    const total = RESOURCES.reduce((sum, r) => sum + first.quantities[r], 0);

    const freeSpace = s.ship.cargoCapacity - this.cargoUsed();
    if (total > freeSpace) {
      return `Not enough cargo space — need ${total}, ${freeSpace} free`;
    }
    const cost = RESOURCES.reduce(
      (sum, r) => sum + buyPrice(port.prices[r]) * first.quantities[r],
      0,
    );
    if (cost > s.ship.gold) {
      return `Not enough gold — need ${cost}, have ${s.ship.gold}`;
    }
    return null;
  });

  // Status line for the autopilot that executes a planned route, or null when
  // no voyage is in progress.
  readonly autopilotStatus = signal<string | null>(null);
  readonly autopilotActive = computed(() => this.autopilot !== null);

  readonly cargoUsed = computed(() => {
    const s = this.state();
    if (!s) return 0;
    return RESOURCES.reduce((sum, r) => sum + s.ship.cargo[r], 0);
  });

  // The hull the player is currently sailing, used to label the HUD and to
  // price shipyard upgrades (the old hull trades in at full value).
  readonly currentBoat = computed<Boat | null>(
    () => findBoat(this.state()?.ship.boatId ?? '') ?? null,
  );

  // ---- movement (kept in plain fields so the render loop never triggers CD)
  private shipX = 0;
  private shipY = 0;
  private vx = 0;
  private vy = 0;
  private heading = -Math.PI / 2;
  private readonly keys = new Set<string>();

  // Active route-trade voyage, or null when sailing manually. The state machine
  // runs each leg in turn — sail to its buy port, buy the planned goods, sail to
  // its sell port, sell them — then advances to the next leg, looping back to the
  // first when `repeat` is set. `busy` is true while a trade request is in flight.
  private autopilot: {
    legs: RouteLeg[];
    index: number;
    repeat: boolean;
    phase: 'toBuy' | 'buying' | 'toSell' | 'selling';
    busy: boolean;
  } | null = null;

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
      // Taking the helm cancels any autopilot voyage in progress.
      if (this.autopilot) this.cancelAutopilot('Voyage cancelled');
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

    if (this.autopilot) {
      // Autopilot steers toward the current target port instead of the keys.
      this.updateAutopilot(dt);
    } else {
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
    const quantity = this.tradeQuantity();
    this.error.set(null);
    this.api.trade(port.id, resource, quantity, action).subscribe({
      next: (s) => this.applyState(s),
      error: (e) => {
        this.error.set(e?.error?.message ?? 'Trade failed');
        setTimeout(() => this.error.set(null), 2500);
      },
    });
  }

  setQuantity(q: number): void {
    this.tradeQuantity.set(Math.max(1, Math.min(50, Math.round(q))));
  }

  resetGame(): void {
    this.autopilot = null;
    this.autopilotStatus.set(null);
    this.api.reset().subscribe((s) => {
      this.applyState(s);
      this.shipX = s.ship.x;
      this.shipY = s.ship.y;
      this.vx = this.vy = 0;
      this.nearbyPort.set(null);
      this.clearRoute();
      this.shipPos.set({ x: Math.round(s.ship.x), y: Math.round(s.ship.y) });
    });
  }

  // Average gold paid per unit for a resource across all purchases so far.
  avgCostOf(r: Resource): number {
    const stats = this.state()?.purchases.perResource[r];
    if (!stats || stats.quantity === 0) return 0;
    return stats.spent / stats.quantity;
  }

  // Price helpers for the template.
  buyPriceOf(port: Port, r: Resource): number {
    return buyPrice(port.prices[r]);
  }
  sellPriceOf(port: Port, r: Resource): number {
    return sellPrice(port.prices[r]);
  }

  // Profit per unit if the held goods were sold here: sell price minus the
  // average cost paid. Positive means selling now turns a profit.
  sellMarginOf(port: Port, r: Resource): number {
    return this.sellPriceOf(port, r) - this.avgCostOf(r);
  }

  // The sell margin as a percentage of the average cost paid.
  sellMarginPctOf(port: Port, r: Resource): number {
    const avg = this.avgCostOf(r);
    if (avg === 0) return 0;
    return (this.sellMarginOf(port, r) / avg) * 100;
  }

  // ---- shipyard ------------------------------------------------------------

  // Hulls a port's shipyard sells, largest last. Only upgrades (capacity above
  // the current hull) are worth showing, so smaller hulls are filtered out.
  boatsAt(port: Port): Boat[] {
    const have = this.state()?.ship.cargoCapacity ?? 0;
    return port.boatIds
      .map((id) => findBoat(id))
      .filter((b): b is Boat => !!b && b.cargoCapacity > have)
      .sort((a, b) => a.cargoCapacity - b.cargoCapacity);
  }

  // Gold to upgrade to a hull: its price minus the current hull's trade-in.
  upgradeCostOf(boat: Boat): number {
    return boat.price - (this.currentBoat()?.price ?? 0);
  }

  // Whether the player can afford to upgrade to the given hull right now.
  canBuyBoat(boat: Boat): boolean {
    const gold = this.state()?.ship.gold ?? 0;
    return this.upgradeCostOf(boat) <= gold;
  }

  // Purchase a larger hull from the docked port's shipyard.
  buyBoat(boat: Boat): void {
    const port = this.nearbyPort();
    if (!port) return;
    this.error.set(null);
    this.api.buyShip(port.id, boat.id).subscribe({
      next: (s) => this.applyState(s),
      error: (e) => {
        this.error.set(e?.error?.message ?? 'Could not buy ship');
        setTimeout(() => this.error.set(null), 2500);
      },
    });
  }

  // ---- route planner -------------------------------------------------------

  // Leg 1 sails port 1 → port 2 (buy at A, sell at B); leg 2 is the return
  // trip port 2 → port 1 (buy at B, sell at A).
  private legBuyPort(leg: 1 | 2): Port | null {
    return leg === 1 ? this.portA() : this.portB();
  }
  private legSellPort(leg: 1 | 2): Port | null {
    return leg === 1 ? this.portB() : this.portA();
  }
  private legQuantitiesSignal(leg: 1 | 2) {
    return leg === 1 ? this.leg1Quantities : this.leg2Quantities;
  }

  // Quantity of a good planned for a leg.
  legQuantityOf(leg: 1 | 2, r: Resource): number {
    return this.legQuantitiesSignal(leg)()[r];
  }

  // Total units carried on a leg, across all goods.
  legTotalQuantity(leg: 1 | 2): number {
    const q = this.legQuantitiesSignal(leg)();
    return RESOURCES.reduce((sum, r) => sum + q[r], 0);
  }

  // Price to buy / sell a good on the given leg.
  legBuyPriceOf(leg: 1 | 2, r: Resource): number {
    const port = this.legBuyPort(leg);
    return port ? buyPrice(port.prices[r]) : 0;
  }
  legSellPriceOf(leg: 1 | 2, r: Resource): number {
    const port = this.legSellPort(leg);
    return port ? sellPrice(port.prices[r]) : 0;
  }

  // Profit per unit of buying at the leg's origin and selling at its destination.
  legMarginOf(leg: 1 | 2, r: Resource): number {
    return this.legSellPriceOf(leg, r) - this.legBuyPriceOf(leg, r);
  }

  // The leg margin as a percentage of the buy price.
  legMarginPctOf(leg: 1 | 2, r: Resource): number {
    const buy = this.legBuyPriceOf(leg, r);
    if (buy === 0) return 0;
    return (this.legMarginOf(leg, r) / buy) * 100;
  }

  // Set how many units of a good to trade on a leg (clamped to 0–999).
  setLegQuantity(leg: 1 | 2, r: Resource, value: number): void {
    const q = Math.max(0, Math.min(999, Math.round(value || 0)));
    this.legQuantitiesSignal(leg).update((m) => ({ ...m, [r]: q }));
  }

  clearRoute(): void {
    this.portAId.set(null);
    this.portBId.set(null);
    this.leg1Quantities.set(emptyInventory());
    this.leg2Quantities.set(emptyInventory());
  }

  // ---- route autopilot -----------------------------------------------------

  // Begin a voyage: run each leg in turn (sail to its buy port, buy, sail to its
  // sell port, sell), looping when "repeat" is set. Closes the map to watch.
  startRouteTrade(): void {
    const legs = this.routeLegs();
    if (legs.length === 0) return;
    if (this.autopilot) return;

    // Cargo / gold are validated reactively via routeTradeBlock(), which also
    // disables the button — bail defensively if anything blocks the voyage.
    if (this.routeTradeBlock()) return;

    this.autopilot = {
      legs,
      index: 0,
      repeat: this.routeRepeat(),
      phase: 'toBuy',
      busy: false,
    };
    this.keys.clear();
    this.showMap.set(false);
    const name = this.portName(legs[0].buyPortId);
    this.autopilotStatus.set(`Sailing to ${name} to buy…`);
  }

  // Steer the ship toward the current leg's target port; on arrival, run trades.
  private updateAutopilot(dt: number): void {
    const a = this.autopilot;
    const s = this.state();
    if (!a || !s) return;

    // While a trade request is in flight, coast (friction) and wait.
    if (a.busy) return;

    const leg = a.legs[a.index];
    const targetId = a.phase === 'toBuy' ? leg.buyPortId : leg.sellPortId;
    const port = s.ports.find((p) => p.id === targetId);
    if (!port) {
      this.cancelAutopilot('Port no longer exists');
      return;
    }

    const dx = port.x - this.shipX;
    const dy = port.y - this.shipY;
    const dist = Math.hypot(dx, dy);

    // Arrived inside the dock ring — stop and trade.
    if (dist <= DOCK_RADIUS * 0.6) {
      this.vx = 0;
      this.vy = 0;
      if (a.phase === 'toBuy') {
        a.phase = 'buying';
        this.autopilotStatus.set(`Buying at ${port.name}…`);
        this.runTrades(port.id, 'buy', leg.quantities, () => {
          if (!this.autopilot) return;
          this.autopilot.phase = 'toSell';
          const dest = this.portName(leg.sellPortId);
          this.autopilotStatus.set(`Sailing to ${dest} to sell…`);
        });
      } else {
        a.phase = 'selling';
        this.autopilotStatus.set(`Selling at ${port.name}…`);
        this.runTrades(port.id, 'sell', leg.quantities, () => this.advanceLeg());
      }
      return;
    }

    // Otherwise accelerate toward the target.
    this.vx += (dx / dist) * this.ACCEL * dt;
    this.vy += (dy / dist) * this.ACCEL * dt;
  }

  // Move on to the next leg, looping back to the first when repeating; otherwise
  // the voyage is complete.
  private advanceLeg(): void {
    const a = this.autopilot;
    if (!a) return;

    const next = a.index + 1;
    if (next < a.legs.length) {
      a.index = next;
    } else if (a.repeat) {
      a.index = 0;
    } else {
      this.finishAutopilot();
      return;
    }
    a.phase = 'toBuy';
    const name = this.portName(a.legs[a.index].buyPortId);
    this.autopilotStatus.set(`Sailing to ${name} to buy…`);
  }

  private portName(id: string): string {
    return this.state()?.ports.find((p) => p.id === id)?.name ?? 'port';
  }

  // Persist the ship's position, then trade each planned good in turn so the
  // backend's docking check agrees before the orders go through.
  private runTrades(
    portId: string,
    action: 'buy' | 'sell',
    quantities: Inventory,
    done: () => void,
  ): void {
    if (!this.autopilot) return;
    this.autopilot.busy = true;
    this.lastSyncedPos = { x: this.shipX, y: this.shipY };
    this.api.move(this.shipX, this.shipY).subscribe({
      next: () => this.tradeNext(portId, action, quantities, 0, done),
      error: () => this.cancelAutopilot('Could not reach the port'),
    });
  }

  private tradeNext(
    portId: string,
    action: 'buy' | 'sell',
    quantities: Inventory,
    index: number,
    done: () => void,
  ): void {
    const a = this.autopilot;
    if (!a) return;

    // Skip goods with nothing to trade.
    let i = index;
    while (i < RESOURCES.length && quantities[RESOURCES[i]] <= 0) i++;
    if (i >= RESOURCES.length) {
      a.busy = false;
      done();
      return;
    }

    const r = RESOURCES[i];
    this.api.trade(portId, r, quantities[r], action).subscribe({
      next: (st) => {
        this.applyState(st);
        this.tradeNext(portId, action, quantities, i + 1, done);
      },
      error: (e) =>
        this.cancelAutopilot(e?.error?.message ?? `Could not ${action} ${r}`),
    });
  }

  private finishAutopilot(): void {
    this.autopilot = null;
    this.autopilotStatus.set('Voyage complete');
    setTimeout(() => this.autopilotStatus.set(null), 2500);
  }

  private cancelAutopilot(message: string): void {
    this.autopilot = null;
    this.autopilotStatus.set(null);
    this.flashError(message);
  }

  // Show an error toast that clears itself after a moment.
  private flashError(message: string): void {
    this.error.set(message);
    setTimeout(() => this.error.set(null), 2500);
  }

  // Click on the world map to pick the two route ports in order. Clicking a
  // selected port deselects it; a third pick restarts the selection.
  onMapClick(event: MouseEvent): void {
    if (!this.showMap()) return;
    const s = this.state();
    if (!s) return;

    const canvas = this.canvasRef().nativeElement;
    const { ox, oy, scale } = this.mapTransform(
      canvas.width,
      canvas.height,
      s.world.width,
    );

    const hit = s.ports.find((p) => {
      const px = ox + p.x * scale;
      const py = oy + p.y * scale;
      return Math.hypot(event.offsetX - px, event.offsetY - py) <= 14;
    });
    if (!hit) return;

    if (this.portAId() === hit.id) {
      this.portAId.set(null);
    } else if (this.portBId() === hit.id) {
      this.portBId.set(null);
    } else if (this.portAId() === null) {
      this.portAId.set(hit.id);
    } else if (this.portBId() === null) {
      this.portBId.set(hit.id);
    } else {
      // Both already chosen — restart the selection from this port.
      this.portAId.set(hit.id);
      this.portBId.set(null);
    }
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

  // Geometry of the square world-map panel within the viewport. Shared by the
  // renderer and the click hit-test so they always agree on port positions.
  private mapTransform(
    W: number,
    H: number,
    worldWidth: number,
  ): { size: number; ox: number; oy: number; scale: number } {
    const size = Math.min(W, H) * 0.8;
    return {
      size,
      ox: (W - size) / 2,
      oy: (H - size) / 2,
      scale: size / worldWidth,
    };
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
    const { size, ox, oy, scale } = this.mapTransform(W, H, s.world.width);

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
    ctx.fillText('click two ports for a route · M to close', ox + size, oy - 12);

    const aId = this.portAId();
    const bId = this.portBId();

    // Trade-route line between the two chosen ports.
    const aP = this.portA();
    const bP = this.portB();
    if (aP && bP) {
      ctx.beginPath();
      ctx.moveTo(ox + aP.x * scale, oy + aP.y * scale);
      ctx.lineTo(ox + bP.x * scale, oy + bP.y * scale);
      ctx.strokeStyle = 'rgba(127,209,185,0.5)';
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Ports.
    for (const p of s.ports) {
      const px = ox + p.x * scale;
      const py = oy + p.y * scale;
      const isA = p.id === aId;
      const isB = p.id === bId;

      // Highlight ring + role badge for a chosen port.
      if (isA || isB) {
        const accent = isA ? '#e0c068' : '#7fd1b9';
        ctx.beginPath();
        ctx.arc(px, py, 9, 0, Math.PI * 2);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = accent;
        ctx.font = '700 9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(isA ? '1' : '2', px, py + 18);
      }

      ctx.fillStyle = isB ? '#7fd1b9' : '#e0c068';
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

// One leg of a planned route: buy these goods at one port, sell them at another.
interface RouteLeg {
  buyPortId: string;
  sellPortId: string;
  quantities: Inventory;
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

function emptyInventory(): Inventory {
  return RESOURCES.reduce(
    (acc, r) => ((acc[r] = 0), acc),
    {} as Inventory,
  );
}
