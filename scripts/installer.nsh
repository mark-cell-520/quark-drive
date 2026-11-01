; ---------------------------------------------------------------------------
; installer.nsh — electron-builder NSIS customizations for QuarkDrive
;
; The one-click installer must leave the machine ready to mount:
;   1. install the bundled WinFsp driver MSI when WinFsp is missing
;      (rclone cannot create a drive letter without it)
;   2. keep everything else default (app shortcut, uninstaller, ...)
; ---------------------------------------------------------------------------

; Close a running instance before install/uninstall. The template's
; CHECK_APP_RUNNING cannot be used in our single-script build (its
; GetProcessInfo path expects separate installer/uninstaller compilations),
; so both contexts use this nsProcess-based check instead. It declares no
; variables, so expanding it in both the installer and the uninstaller is safe.
!macro QUARK_CLOSE_RUNNING_APP
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    DetailPrint "QuarkDrive is running - closing it"
    ${nsProcess::KillProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    Sleep 1000
  ${EndIf}
!macroend

!macro customCheckAppRunning
  !insertmacro QUARK_CLOSE_RUNNING_APP
!macroend

!macro customInstall
  ; WinFsp ships as an MSI that installs to Program Files\WinFsp (64-bit) or
  ; Program Files (x86)\WinFsp (32-bit package). Presence of the bin dir is the
  ; most reliable "already installed" signal.
  StrCpy $0 ""
  IfFileExists "$PROGRAMFILES64\WinFsp\bin\winfsp-x64.dll" 0 +2
    StrCpy $0 "installed"
  IfFileExists "$PROGRAMFILES32\WinFsp\bin\winfsp-x64.dll" 0 +2
    StrCpy $0 "installed"

  ${If} $0 == ""
    DetailPrint "QuarkDrive: installing WinFsp (filesystem driver)..."
    ; the MSI is bundled as an extraResource next to the app
    nsExec::ExecToLog 'msiexec /qn /norestart /i "$INSTDIR\resources\vendor\winfsp.msi"'
    Pop $1
    ${If} $1 == "0"
      DetailPrint "QuarkDrive: WinFsp installed."
    ${ElseIf} $1 == "1603"
      ; already installed / downgrade — treat as success (idempotent intent)
      DetailPrint "QuarkDrive: WinFsp already present (msiexec 1603)."
    ${Else}
      DetailPrint "QuarkDrive: WinFsp install returned $1 — the app will prompt at runtime."
    ${EndIf}
  ${Else}
    DetailPrint "QuarkDrive: WinFsp already installed."
  ${EndIf}
!macroend

; On uninstall we leave WinFsp in place (it is a shared system driver that
; other tools may rely on).
