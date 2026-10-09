// Purpose: Exercise installed Pi dock layout and overlay compositing without a real terminal.
import { TuiAltScreen, type Component, type OverlayOptions } from '@earendil-works/pi-tui';
import { renderLayoutFrame } from '../node_modules/@earendil-works/pi-tui/dist/layout.js';
import { createChatViewport } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js';
export function panelLayout(rows = 15, columns = 80) {
  const terminal = { rows, columns, hideCursor() {}, showCursor() {} };
  const tui = new TuiAltScreen(terminal as any);
  tui.requestRender = () => {};
  const block = (name: string): Component => ({ render: () => Array.from({ length: 15 }, (_, i) => `${name} ${i}`), invalidate() {} });
  const { root } = createChatViewport({ document: block('transcript'), pendingMessages: block('pending'), status: block('status'), widgetsAbove: block('above widget'), editor: block('editor'), widgetsBelow: block('below widget'), footer: block('footer') });
  return {
    tui, terminal,
    mount(component: Component, options: OverlayOptions) { return tui.showOverlay(component, options); },
    compose() {
      const base = renderLayoutFrame(root, terminal.columns, terminal.rows, () => {}).lines;
      return (tui as any).compositeOverlays(base, terminal.columns, terminal.rows).slice(-terminal.rows) as string[];
    },
  };
}
