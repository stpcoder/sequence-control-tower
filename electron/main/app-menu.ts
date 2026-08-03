import type { MenuItemConstructorOptions } from 'electron'
import type { RendererCommand } from '../shared/contracts'

export interface MacMenuOptions {
  appName: string
  development: boolean
  sendCommand(command: RendererCommand): void
}

/** Pure template factory so native menu wiring can be verified without Electron UI. */
export function buildMacMenuTemplate({
  appName,
  development,
  sendCommand
}: MacMenuOptions): MenuItemConstructorOptions[] {
  const command = (value: RendererCommand): (() => void) => () => sendCommand(value)
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: command('preferences') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      role: 'fileMenu',
      submenu: [
        { label: 'Open Logs…', accelerator: 'CmdOrCtrl+O', click: command('open-logs') },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      role: 'editMenu',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find',
          submenu: [
            { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: command('find') },
            { label: 'Find in Logs…', accelerator: 'CmdOrCtrl+Shift+F', click: command('find-workspace') }
          ]
        }
      ]
    },
    {
      role: 'viewMenu',
      submenu: [
        ...(development ? [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }, { type: 'separator' as const }] : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      role: 'windowMenu',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    },
    {
      role: 'help',
      submenu: [
        { label: `${appName} Help`, enabled: false }
      ]
    }
  ]
}
