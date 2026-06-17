import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { GameState, Resource } from './models';

const API = 'http://localhost:3000/game';

@Injectable({ providedIn: 'root' })
export class GameService {
  private readonly http = inject(HttpClient);

  getState(): Observable<GameState> {
    return this.http.get<GameState>(`${API}/state`);
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

  reset(): Observable<GameState> {
    return this.http.post<GameState>(`${API}/reset`, {});
  }
}
