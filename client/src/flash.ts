// A message for the next screen, such as "Bot を作成しました" after a form moves to the new bot. One message is kept in
// memory, and taken (and cleared) by the first screen that reads it.
let pending: string | null = null;

export function setFlash(message: string): void {
  pending = message;
}

// The message left by setFlash, or null. It is cleared, so that a reload of the screen does not show it again.
export function takeFlash(): string | null {
  const message = pending;
  pending = null;
  return message;
}
