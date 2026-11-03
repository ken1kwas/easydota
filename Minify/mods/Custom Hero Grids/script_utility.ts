import { fetchGrids } from "./script";

/** Settings button "Fetch Latest Remote Grids". */
export async function fetch_grids(): Promise<void> {
  await fetchGrids();
}
