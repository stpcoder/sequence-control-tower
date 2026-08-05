!macro customInit
  # electron-builder records the install location under this stable appId-derived key.
  # Check both assisted-install contexts before showing the upgrade confirmation.
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 == ""
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}

  ${If} $0 != ""
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "An existing Sequence Control Tower installation was detected.$\r$\n$\r$\nSelect Yes to continue. electron-builder will remove the previous app binaries before installing this version. Your user app data will be preserved.$\r$\n$\r$\nSelect No to cancel." IDYES +2
    SetErrorLevel 1223
    Quit
  ${EndIf}
!macroend
