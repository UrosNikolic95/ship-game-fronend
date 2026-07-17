import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { GameState, Leaderboard, Resource } from './models';
import { environment } from '../../environments/environment';

const API = `${environment.apiUrl}/game`;

@Injectable({ providedIn: 'root' })
export class GameService {
  private readonly http = inject(HttpClient);

  getState(): Observable<GameState> {
    return this.http.get<GameState>(`${API}/state`);
  }

  // The richest players ever (by peak gold), plus our own standing when we're
  // off the top list. Fetched on demand when the leaderboard panel is opened.
  getLeaderboard(): Observable<Leaderboard> {
    return this.http.get<Leaderboard>(`${API}/leaderboard`);
  }

  // Persist the ship's position. Called periodically, not every frame.
  move(x: number, y: number): Observable<GameState> {
    return this.http.post<GameState>(`${API}/move`, { x, y });
  }

  trade(
    portId: string,
    resource: Resource,
    quantity: number,
    action: 'buy' | 'sell',
  ): Observable<GameState> {
    return this.http.post<GameState>(`${API}/trade`, {
      portId,
      resource,
      quantity,
      action,
    });
  }

  buyShip(portId: string, boatId: string): Observable<GameState> {
    return this.http.post<GameState>(`${API}/buy-ship`, { portId, boatId });
  }

  reset(): Observable<GameState> {
    return this.http.post<GameState>(`${API}/reset`, {});
  }
}
