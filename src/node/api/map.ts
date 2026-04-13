import { ApiClient } from './client.js';
import type { MapData } from '../types.js';

export async function getNearby(client: ApiClient): Promise<MapData> {
  return client.get<MapData>('/map/nearby');
}
