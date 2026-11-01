; ---------------------------------------------------------------------------
; quarkdrive.nsi — custom NSIS installer script for QuarkDrive.
;
; Based on electron-builder's installer.nsi / installSection.nsh templates
; (MIT licensed, electron-builder). Differences:
;
;   1. No BUILD_UNINSTALLER intermediate build: electron-builder's default
;      flow executes a freshly built installer to extract the uninstaller,
;      which is not possible in every build environment (headless CI,
;      sandboxes). Instead the uninstaller is written at install time with
;      WriteUninstaller — the classic NSIS pattern, fully self-contained.
;   2. Everything else (one-click UI, per-machine elevation, shortcuts,
;      auto-update friendly registry entries, run-after-finish) is identical
;      to the upstream templates.
; ---------------------------------------------------------------------------

Var newStartMenuLink
Var oldStartMenuLink
Var newDesktopLink
Var oldDesktopLink
Var oldShortcutName
Var oldMenuDirectory

!include "common.nsh"
!include "MUI2.nsh"
!include "multiUser.nsh"
!include "allowOnlyOneInstallerInstance.nsh"
!include "installer.nsh"          ; macros: registryAddInstallInfo, links, extract
; NOTE: getProcessInfo.nsh is intentionally not included — our
; customCheckAppRunning hook (scripts/installer.nsh) replaces the template's
; process checks with nsProcess, which works in both installer and uninstaller.

!ifdef INSTALL_MODE_PER_ALL_USERS
  RequestExecutionLevel admin
!else
  RequestExecutionLevel user
!endif

Var appExe
Var launchLink

; installUtil.nsh defines functions that reference $appExe, so it must come
; after the Var declarations (same order as electron-builder's templates).
!include "installUtil.nsh"        ; uninstallOldVersion / handleUninstallResult

!ifdef ONE_CLICK
  !include "oneClick.nsh"
!else
  !include "assistedInstaller.nsh"
!endif

!insertmacro addLangs

!ifmacrodef customHeader
  !insertmacro customHeader
!endif

Function .onInit
  Call setInstallSectionSpaceRequired

  SetOutPath $INSTDIR
  ${LogSet} on

  !ifmacrodef preInit
    !insertmacro preInit
  !endif

  !ifdef DISPLAY_LANG_SELECTOR
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro check64BitAndSetRegView

  !ifdef ONE_CLICK
    !insertmacro ALLOW_ONLY_ONE_INSTALLER_INSTANCE
  !else
    ${IfNot} ${UAC_IsInnerInstance}
      !insertmacro ALLOW_ONLY_ONE_INSTALLER_INSTANCE
    ${EndIf}
  !endif

  !insertmacro initMultiUser

  !ifmacrodef customInit
    !insertmacro customInit
  !endif

  !ifmacrodef addLicenseFiles
    InitPluginsDir
    !insertmacro addLicenseFiles
  !endif
FunctionEnd

; ---------------------------------------------------------------------------
; Install section — mirrors electron-builder's installSection.nsh, with the
; pre-built uninstaller copy replaced by an install-time WriteUninstaller.
; ---------------------------------------------------------------------------
Section "install" INSTALL_SECTION_ID
  InitPluginsDir

  ${IfNot} ${Silent}
    SetDetailsPrint none
  ${endif}

  StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

  ; must be called before uninstallOldVersion
  !insertmacro setLinkVars

  !ifdef ONE_CLICK
    !ifdef HEADER_ICO
      File /oname=$PLUGINSDIR\installerHeaderico.ico "${HEADER_ICO}"
    !endif
    ${IfNot} ${Silent}
      !ifdef HEADER_ICO
        SpiderBanner::Show /MODERN /ICON "$PLUGINSDIR\installerHeaderico.ico"
      !else
        SpiderBanner::Show /MODERN
      !endif

      FindWindow $0 "#32770" "" $hwndparent
      FindWindow $0 "#32770" "" $hwndparent $0
      GetDlgItem $0 $0 1000
      SendMessage $0 ${WM_SETTEXT} 0 "STR:$(installing)"

      StrCpy $1 $hwndparent
      System::Call 'user32::ShutdownBlockReasonCreate(${SYSTYPE_PTR}r1, w "$(installing)")'
    ${endif}
    !insertmacro QUARK_CLOSE_RUNNING_APP
  !else
    !insertmacro QUARK_CLOSE_RUNNING_APP
  !endif

  Var /GLOBAL keepShortcuts
  StrCpy $keepShortcuts "false"
  !insertMacro setIsTryToKeepShortcuts
  ${if} $isTryToKeepShortcuts == "true"
    ReadRegStr $R1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" KeepShortcuts

    ${if} $R1 == "true"
    ${andIf} ${FileExists} "$appExe"
      StrCpy $keepShortcuts "true"
    ${endIf}
  ${endif}

  !insertmacro uninstallOldVersion SHELL_CONTEXT
  !insertmacro handleUninstallResult SHELL_CONTEXT

  ${if} $installMode == "all"
    !insertmacro uninstallOldVersion HKEY_CURRENT_USER
    !insertmacro handleUninstallResult HKEY_CURRENT_USER
  ${endIf}

  SetOutPath $INSTDIR

  !ifdef UNINSTALLER_ICON
    File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"
  !endif

  ; --- app payload (from electron-builder's installApplicationFiles) --------
  !insertmacro extractEmbeddedAppPackage
  ; electron always uses per user app data
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endIf}
  !insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endIf}

  ; --- uninstaller: written at install time (no build-time extraction) ------
  WriteUninstaller "$INSTDIR\${UNINSTALL_FILENAME}"

  !insertmacro registryAddInstallInfo
  !insertmacro addStartMenuLink $keepShortcuts
  !insertmacro addDesktopLink $keepShortcuts

  ${if} ${FileExists} "$newStartMenuLink"
    StrCpy $launchLink "$newStartMenuLink"
  ${else}
    StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${endIf}

  !ifmacrodef registerFileAssociations
    !insertmacro registerFileAssociations
  !endif

  !ifmacrodef customInstall
    !insertmacro customInstall
  !endif

  !macro doStartApp
    ; otherwise app window will be in background
    HideWindow
    !insertmacro StartApp
  !macroend

  !ifdef ONE_CLICK
    !ifdef RUN_AFTER_FINISH
      ${ifNot} ${Silent}
      ${orIf} ${isForceRun}
        !insertmacro doStartApp
      ${endIf}
    !else
      ${if} ${isForceRun}
        !insertmacro doStartApp
      ${endIf}
    !endif
    !insertmacro quitSuccess
  !else
    ; for assisted installer run only if silent
    ${if} ${isForceRun}
    ${andIf} ${Silent}
      !insertmacro doStartApp
    ${endIf}
  !endif
SectionEnd

Function setInstallSectionSpaceRequired
  !insertmacro setSpaceRequired ${INSTALL_SECTION_ID}
FunctionEnd

; ---------------------------------------------------------------------------
; Uninstaller (compiled into the installer, written at install time)
; ---------------------------------------------------------------------------
!include "uninstaller.nsh"
