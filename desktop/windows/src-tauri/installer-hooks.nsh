; A packaged launcher can redirect LOCALAPPDATA into its own package cache.
; Preserve normal/custom installation paths; relocate only this known bad default.
!define CHEVOINK_ICON_SOURCE "${__FILEDIR__}\icons\icon.ico"
!define CHEVOINK_SETUP_DIR "${__FILEDIR__}"
Var ChevoinkInstalled

; Existing shortcuts may cache the old executable icon by its unchanged path.
; Use an installed, content-versioned icon, never a build/tool-cache path.
!macro RefreshChevoinkIcon shortcut
  !insertmacro IsShortcutTarget "${shortcut}" "$INSTDIR\chevoink-desktop.exe"
  Pop $0
  ${If} $0 = 1
    ; Modify only IconLocation: preserve target, arguments and AppUserModelId.
    !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
    ${If} $0 P<> 0
      ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
      ${If} $1 P<> 0
        ${IPersistFile::Load} $1 '("${shortcut}", ${STGM_READWRITE})'
        ${IShellLink::SetIconLocation} $0 '("$INSTDIR\chevoink-logo-212aa389.ico", 0)'
        ${IPersistFile::Save} $1 '("${shortcut}",1)'
        ${IUnknown::Release} $1 ""
      ${EndIf}
      ${IUnknown::Release} $0 ""
    ${EndIf}
    System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "${shortcut}", p 0)'
  ${EndIf}
!macroend

Function RefreshChevoinkShortcuts
  !insertmacro RefreshChevoinkIcon "$DESKTOP\Chevoink.lnk"
  !insertmacro RefreshChevoinkIcon "$SMPROGRAMS\Chevoink.lnk"
FunctionEnd

Function .onGUIEnd
  ${If} $ChevoinkInstalled = 1
    Call RefreshChevoinkShortcuts
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  SetOutPath "$INSTDIR"
  File /oname=chevoink-logo-212aa389.ico "${CHEVOINK_ICON_SOURCE}"
  StrCpy $ChevoinkInstalled 1
  Call RefreshChevoinkShortcuts
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\chevoink-logo-212aa389.ico"
!macroend

!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $1
  System::Call 'shlwapi::StrStrIW(w "$INSTDIR", w "\Packages\OpenAI.Codex_") p.r0'
  ${If} $0 != 0
    ReadEnvStr $1 "USERPROFILE"
    ${If} $1 == ""
      Abort "Cannot resolve the Windows user profile. Please select an independent installation directory."
    ${EndIf}
    StrCpy $INSTDIR "$1\AppData\Local\Programs\Chevoink"
  ${EndIf}
  Pop $1
  Pop $0
!macroend
