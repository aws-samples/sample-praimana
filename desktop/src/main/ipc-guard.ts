import { ipcMain } from "electron";
import { isOwnRendererUrl } from "./renderer-document";

// M-4: validate the origin of every IPC call. Only the app's own renderer
// (the dev Vite server or the packaged file:// document) may invoke handlers —
// so injected/embedded content can't reach the privileged main-process bridge.
//
// ⚠ THE CHECK USED TO TRUST ANY `file://` SENDER, which is a different claim from the one the
// comment above makes. A document at any local path passed it, with the same preload attached and
// all ~120 channels reachable. `isOwnRendererUrl` compares against the document this app actually
// loaded; see renderer-document.ts for how that URL legitimately varies and why the comparison is
// on the resolved path.
function isAllowedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  return isOwnRendererUrl(event.senderFrame?.url);
}

/**
 * Wrap ipcMain.handle / ipcMain.on so every registered handler first checks the
 * sender origin. Call once, before any setup*Handlers().
 */
export function installIpcSenderGuard(): void {
  const origHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = ((channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any) => {
    origHandle(channel, (event, ...args) => {
      if (!isAllowedSender(event)) {
        throw new Error(`IPC "${channel}" rejected: untrusted sender`);
      }
      return listener(event, ...args);
    });
  }) as typeof ipcMain.handle;

  const origOn = ipcMain.on.bind(ipcMain);
  ipcMain.on = ((channel: string, listener: (event: Electron.IpcMainEvent, ...args: any[]) => void) => {
    return origOn(channel, (event, ...args) => {
      if (!isAllowedSender(event)) return;
      listener(event, ...args);
    });
  }) as typeof ipcMain.on;
}
