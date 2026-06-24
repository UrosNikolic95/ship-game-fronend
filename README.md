# Ship Game — Frontend

The web client for a 2D sailing & trading game. You captain a ship across an
unbounded, procedurally generated sea, dock at ports, buy goods where they're
cheap and sell them where they're dear, and upgrade to larger hulls as your
fortune grows. The game world and economy are owned by the
[NestJS backend](../backend); this app renders them on a canvas and drives the
ship.

Built with [Angular](https://angular.dev/) 21 and TypeScript. Rendering is done
on an HTML5 `<canvas>`.

## How to play

- **Sail** with `WASD` or the arrow keys. The world scrolls beneath you and new
  ports appear as you explore.
- **Dock** by sailing within range of a port; a trade panel opens, letting you
  buy and sell goods or upgrade your ship at ports with a shipyard.
- **Map** — press `M` to toggle the full-world overlay.
- **Route planner** — pick two ports on the map to plan a round trip, set how
  much of each good to trade on each leg, and let the autopilot run the loop
  (optionally repeating) while you watch the profit roll in.

Goods are `wood`, `grain`, `iron`, `spice`, and `cloth`. You buy at a markup and
sell at a markdown, so profit comes from the price spread between ports. The
client mirrors the backend's pricing constants so it can preview what a trade
will cost before sending it.

> Run the [backend](../backend) first — the client talks to it at
> `http://localhost:3000/game`.

## Project layout

```
src/
  main.ts                bootstrap
  app/
    app.routes.ts        single route -> Game component
    app.config.ts        app providers (HttpClient, router)
    game/
      game.ts            the game component: rendering, input, autopilot
      game.html / .css   HUD, trade panel, map overlay, route planner
      game.service.ts    HTTP calls to the backend /game API
      models.ts          domain types & pricing constants (mirror the backend)
```

## Setup

```bash
npm install
```

## Development server

```bash
npm start        # or: ng serve
```

Open `http://localhost:4200/`. The app reloads on source changes.

## Build

```bash
npm run build    # or: ng build
```

Build artifacts are written to `dist/`.

## Tests

```bash
npm test         # unit tests via Vitest
```
