// Set when the app itself leaves the page (the move to the login page), so that the screens with unsaved
// changes do not ask the browser to confirm leaving, which could cancel the move.
let leaving = false;

export function markLeaving(): void {
  leaving = true;
}

export function isLeaving(): boolean {
  return leaving;
}
