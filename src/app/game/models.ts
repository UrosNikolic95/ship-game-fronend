// Mirrors the backend game-domain types.

export const RESOURCES = ['wood', 'grain', 'iron', 'spice', 'cloth'] as const;
export type Resource = (typeof RESOURCES)[number];

export type Inventory = Record<Resource, number>;

export interface Ship {
  x: number;
  y: number;
  gold: number;
  cargo: Inventory;
  cargoCapacity: number;
  // Which hull the player is sailing; drives cargo capacity. See BOATS.
  boatId: string;
}

export interface Port {
  id: string;
  name: string;
  x: number;
  y: number;
  prices: Record<Resource, number>;
  // Hulls this port's shipyard sells. Empty when the port has no shipyard.
  boatIds: string[];
}

// A buyable hull. Larger hulls carry more cargo but cost more gold.
export interface Boat {
  id: string;
  name: string;
  cargoCapacity: number;
  price: number;
}

// Buyable hulls, smallest to largest — kept in sync with the backend. The sloop
// is the starting boat and is never sold (price 0).
export const BOATS: Boat[] = [
  { id: 'sloop', name: 'Sloop', cargoCapacity: 50, price: 0 },
  { id: 'cutter', name: 'Cutter', cargoCapacity: 120, price: 1500 },
  { id: 'trader', name: 'Trader', cargoCapacity: 250, price: 4500 },
  { id: 'galleon', name: 'Galleon', cargoCapacity: 500, price: 12000 },
];

export const findBoat = (id: string): Boat | undefined =>
  BOATS.find((b) => b.id === id);

export interface PurchaseStats {
  totalSpent: number;
  perResource: Record<Resource, { spent: number; quantity: number }>;
}

// One row of the leaderboard: a player's rank, display name, and peak gold
// (the most gold they've ever held at once). Mirrors the backend shape — no raw
// user id is sent; `isCurrentUser` lets us highlight our own row instead.
export interface LeaderboardEntry {
  rank: number;
  name: string;
  gold: number;
  achievedAt: string | null;
  isCurrentUser: boolean;
}

// The leaderboard as returned for one player: the top entries, plus that
// player's own standing when they didn't make the top list (null when they're
// already in `top` — flagged there via isCurrentUser — or aren't ranked yet).
export interface Leaderboard {
  top: LeaderboardEntry[];
  currentUser: LeaderboardEntry | null;
}

// One generated square of the infinite world. Chunk (cx, cy) covers
// [cx*chunkSize, (cx+1)*chunkSize) x [cy*chunkSize, (cy+1)*chunkSize).
export interface ChunkCoord {
  cx: number;
  cy: number;
}

export interface GameState {
  // World units per chunk; the world is an unbounded grid of these squares.
  chunkSize: number;
  // World seed; chunk content is generated deterministically from it.
  seed: number;
  // Chunks generated so far. Chunk (0,0) is the hand-made starting area.
  chunks: ChunkCoord[];
  ship: Ship;
  ports: Port[];
  purchases: PurchaseStats;
}

// Price spreads — kept in sync with the backend so the UI can show what a
// trade will cost before sending it.
export const BUY_MARKUP = 1.15;
export const SELL_MARKDOWN = 0.85;
export const DOCK_RADIUS = 60;

export const buyPrice = (base: number) => Math.ceil(base * BUY_MARKUP);
export const sellPrice = (base: number) => Math.floor(base * SELL_MARKDOWN);
