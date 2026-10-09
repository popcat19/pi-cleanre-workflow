// Purpose: Bind focused panels to compositor-confirmed full-terminal overlay bounds.
import type { OverlayHandle, OverlayOptions } from '@earendil-works/pi-tui';

export const PANEL_OVERLAY: OverlayOptions = { width: '100%', maxHeight: '100%', row: 0, col: 0, margin: 0 };
export class PanelViewport {
  private handle?: OverlayHandle;
  private composited = false;
  constructor(readonly terminal: { rows: number; columns: number }) {}
  bind(handle: OverlayHandle) { this.handle = handle; }
  beginRender() { this.composited = false; }
  compose() { this.composited = true; }
  visible(width: number, rows: number, lines: number): boolean {
    const bounds = this.handle?.getBounds();
    return !!bounds && this.composited && this.handle!.isFocused() && !this.handle!.isHidden()
      && width === this.terminal.columns && rows === this.terminal.rows
      && bounds.row === 0 && bounds.col === 0 && bounds.width === width
      && bounds.height === lines && lines <= rows;
  }
}
