; ---------------------------------------------------------------------------
; installer.nsh — electron-builder NSIS customizations for QuarkDrive
;
; The one-click installer must leave the machine ready to mount:
;   1. install the bundled WinFsp driver MSI when WinFsp is missing
;      (rclone cannot create a drive letter without it), with logging, one
;      retry on transient failures, and a post-install presence check
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

; True when the WinFsp driver files are present on this machine.
; The launcher service is the reliable runtime signal; the bin dir is the
; most reliable "already installed" signal.
!macro QUARK_WINFSP_PRESENT
  IfFileExists "$PROGRAMFILES64\WinFsp\bin\winfsp-x64.dll" 0 +2
    StrCpy $0 "installed"
  IfFileExists "$PROGRAMFILES32\WinFsp\bin\winfsp-x64.dll" 0 +2
    StrCpy $0 "installed"
!macroend

!macro customInstall
  ; WinFsp ships as an MSI that installs to Program Files\WinFsp (64-bit) or
  ; Program Files (x86)\WinFsp (32-bit package).
  StrCpy $0 ""
  !insertmacro QUARK_WINFSP_PRESENT

  ${If} $0 == ""
    DetailPrint "QuarkDrive: installing WinFsp (filesystem driver)..."
    ; the MSI is bundled as an extraResource next to the app; log the install
    ; so a failed driver setup is diagnosable from %TEMP%
    StrCpy $1 ""
    nsExec::ExecToLog 'msiexec /qn /norestart /i "$INSTDIR\resources\vendor\winfsp.msi" /l*v "$TEMP\quarkdrive-winfsp-install.log"'
    Pop $1
    ${If} $1 == "0"
      DetailPrint "QuarkDrive: WinFsp installed."
    ${ElseIf} $1 == "1603"
      ; already installed / downgrade — treat as success (idempotent intent)
      DetailPrint "QuarkDrive: WinFsp already present (msiexec 1603)."
    ${ElseIf} $1 == "1602"
      ; user cancelled — impossible under /qn, but a cancelled driver install
      ; must never leave a half-working app behind silently
      DetailPrint "QuarkDrive: WinFsp install was cancelled (msiexec 1602)."
    ${Else}
      ; transient failures (e.g. 1618 = another install in progress): retry once
      DetailPrint "QuarkDrive: WinFsp install returned $1 - retrying once..."
      Sleep 3000
      StrCpy $1 ""
      nsExec::ExecToLog 'msiexec /qn /norestart /i "$INSTDIR\resources\vendor\winfsp.msi" /l*v "$TEMP\quarkdrive-winfsp-install.log"'
      Pop $1
      ${If} $1 == "0"
      ${OrIf} $1 == "1603"
        DetailPrint "QuarkDrive: WinFsp installed on retry."
      ${Else}
        DetailPrint "QuarkDrive: WinFsp install returned $1 again - the app will prompt at runtime."
      ${EndIf}
    ${EndIf}

    ; post-install verification: the driver files must exist now
    StrCpy $0 ""
    !insertmacro QUARK_WINFSP_PRESENT
    ${If} $0 == ""
      DetailPrint "QuarkDrive: WARNING - WinFsp files still missing after install;"
      DetailPrint "the app will offer to install it again on first mount."
    ${Else}
      DetailPrint "QuarkDrive: WinFsp verified present."
    ${EndIf}
  ${Else}
    DetailPrint "QuarkDrive: WinFsp already installed."
  ${EndIf}
!macroend

; On uninstall we leave WinFsp in place (it is a shared system driver that
; other tools may rely on).
