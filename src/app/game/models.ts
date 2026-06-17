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
}

export interface Port {
  id: string;
  name: string;
  x: number;
  y: number;
  prices: Record<Resource, number>;
}

export interface PurchaseStats {
  totalSpent: number;
  perResource: Record<Resource, { spent: number; qty: number }>;
}

export interface GameState {
  world: { width: number; height: number };
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
