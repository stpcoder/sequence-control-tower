import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import type { RendererCommand } from '../../electron/shared/contracts'
import { buildMacMenuTemplate } from '../../electron/main/app-menu'

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return item.submenu as MenuItemConstructorOptions[]
}

function invoke(item: MenuItemConstructorOptions): void {
  ;(item.click as unknown as () => void)()
}

describe('macOS application menu', () => {
  it('provides standard macOS menus and routes native accelerators to renderer commands', () => {
    const commands: RendererCommand[] = []
    const template = buildMacMenuTemplate({
      appName: 'Sequence Control Tower',
      development: false,
      sendCommand: (command) => commands.push(command)
    })

    expect(template.map((item) => item.role ?? item.label)).toEqual([
      'Sequence Control Tower',
      'fileMenu',
      'editMenu',
      'viewMenu',
      'windowMenu',
      'help'
    ])

    const settings = submenu(template[0]).find((item) => item.accelerator === 'CmdOrCtrl+,')
    const open = submenu(template[1]).find((item) => item.accelerator === 'CmdOrCtrl+O')
    const findMenu = submenu(template[2]).find((item) => item.label === 'Find')!
    const find = submenu(findMenu).find((item) => item.accelerator === 'CmdOrCtrl+F')
    const findWorkspace = submenu(findMenu).find((item) => item.accelerator === 'CmdOrCtrl+Shift+F')

    expect(settings).toBeDefined()
    expect(open).toBeDefined()
    expect(find).toBeDefined()
    expect(findWorkspace).toBeDefined()
    invoke(settings!)
    invoke(open!)
    invoke(find!)
    invoke(findWorkspace!)
    expect(commands).toEqual(['preferences', 'open-logs', 'find', 'find-workspace'])

    expect(submenu(template[0]).map((item) => item.role).filter(Boolean)).toEqual(
      expect.arrayContaining(['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit'])
    )
    expect(submenu(template[2]).map((item) => item.role).filter(Boolean)).toEqual(
      expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll'])
    )
  })

  it('shows reload and developer tools only for development builds', () => {
    const production = buildMacMenuTemplate({ appName: 'App', development: false, sendCommand: () => undefined })
    const development = buildMacMenuTemplate({ appName: 'App', development: true, sendCommand: () => undefined })
    const productionRoles = submenu(production[3]).map((item) => item.role)
    const developmentRoles = submenu(development[3]).map((item) => item.role)

    expect(productionRoles).not.toContain('reload')
    expect(productionRoles).not.toContain('toggleDevTools')
    expect(developmentRoles).toContain('reload')
    expect(developmentRoles).toContain('toggleDevTools')
  })
})
