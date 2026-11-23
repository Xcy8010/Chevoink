; Chevoink's interactive pages use the native MUI shell, its DPI-scaled layout,
; system fonts, translated controls and the same install sections as /S and /P.
!define /ifndef MUI_BGCOLOR "SYSCLR:5" ; COLOR_WINDOW
!define /ifndef MUI_TEXTCOLOR "SYSCLR:8" ; COLOR_WINDOWTEXT
SetFont /LANG=2052 "Microsoft YaHei UI" 9
SetFont /LANG=1033 "Segoe UI" 9
Var ChevoinkExistingVersion
Var ChevoinkLanguageChild
Var ChevoinkShortcutChoice
Var ChevoinkOptionsOpen
Var ChevoinkChangePath
Var ChevoinkOptionsControl
Var ChevoinkPathControl
Var ChevoinkBrowseControl
Var ChevoinkLanguageControl
Var ChevoinkShortcutControl

!macro ChevoinkText key chinese english
  LangString Chevoink${key} 2052 "${chinese}"
  LangString Chevoink${key} 1033 "${english}"
!macroend
!insertmacro ChevoinkText InstallTitle "安装启创墨域" "Install Chevoink"
!insertmacro ChevoinkText UpdateTitle "更新启创墨域" "Update Chevoink"
!insertmacro ChevoinkText RepairTitle "重新安装启创墨域" "Reinstall Chevoink"
!insertmacro ChevoinkText OlderTitle "安装较早版本" "Install an earlier version"
!insertmacro ChevoinkText Install "安装" "&Install"
!insertmacro ChevoinkText Update "更新" "&Update"
!insertmacro ChevoinkText Repair "重新安装" "&Reinstall"
!insertmacro ChevoinkText Version "Windows 桌面版   ·   ${VERSION}" "Windows desktop   ·   ${VERSION}"
!insertmacro ChevoinkText Versions "$ChevoinkExistingVersion   →   ${VERSION}" "$ChevoinkExistingVersion   →   ${VERSION}"
!insertmacro ChevoinkText User "仅为当前 Windows 账户安装" "For your Windows account"
!insertmacro ChevoinkText Options "▸  安装选项" "▸  Installation &options"
!insertmacro ChevoinkText HideOptions "▾  收起选项" "▾  Hide &options"
!insertmacro ChevoinkText Folder "安装位置" "Installation folder"
!insertmacro ChevoinkText ChangeFolder "更改位置…" "Change &folder…"
!insertmacro ChevoinkText Shortcut "创建桌面快捷方式" "Create a &desktop shortcut"
!insertmacro ChevoinkText OtherLanguage "English" "简体中文"
!insertmacro ChevoinkText LanguageError "无法切换安装语言，请重试。" "Setup could not switch languages. Please try again."
!insertmacro ChevoinkText Ready "启创墨域已安装" "Chevoink is installed"
!insertmacro ChevoinkText Updated "启创墨域已更新" "Chevoink is updated"
!insertmacro ChevoinkText Open "打开启创墨域" "&Open Chevoink"
!insertmacro ChevoinkText Close "关闭" "&Close"

; NSIS selects its language table at the end of .onInit. A user-initiated
; language change restarts only the wizard, before any installation work.
Function ChevoinkReadWizardLanguage
  ReadEnvStr $0 CHEVOINK_SETUP_LANGUAGE
  ${If} $0 == 1033
  ${OrIf} $0 == 2052
    StrCpy $LANGUAGE $0
    StrCpy $ChevoinkLanguageChild 1
    ReadEnvStr $ChevoinkShortcutChoice CHEVOINK_SETUP_SHORTCUT
    StrCpy $ChevoinkOptionsOpen 1
    System::Call 'kernel32::SetEnvironmentVariableW(w "CHEVOINK_SETUP_LANGUAGE", p 0)'
    System::Call 'kernel32::SetEnvironmentVariableW(w "CHEVOINK_SETUP_SHORTCUT", p 0)'
  ${EndIf}
  ClearErrors
FunctionEnd

Function ChevoinkSwitchLanguage
  Pop $0 ; clicked control
  ${NSD_GetState} $ChevoinkShortcutControl $1
  ; The first wizard waits for each language-specific GUI in turn, retaining
  ; its caller's exit status and at most one child regardless of switch count.
  ; Four private return values encode target language and shortcut preference.
  ${If} $ChevoinkLanguageChild == 1
    IntOp $0 32000 + $1
    ${If} $LANGUAGE == 1033
      IntOp $0 $0 + 2
    ${EndIf}
    SetErrorLevel $0
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_CLOSE}, p 0, p 0)'
    Return
  ${EndIf}
  ${If} $LANGUAGE == 2052
    StrCpy $0 1033
  ${Else}
    StrCpy $0 2052
  ${EndIf}
  chevoink_show_language:
  System::Call 'kernel32::SetEnvironmentVariableW(w "CHEVOINK_SETUP_LANGUAGE", w r0)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "CHEVOINK_SETUP_SHORTCUT", w r1)'
  ${GetParameters} $0
  ClearErrors
  HideWindow
  ; NSIS consumes /D before populating $CMDLINE. Forward the effective
  ; directory as its final, unquoted /D argument (including embedded spaces).
  ExecWait '"$EXEPATH" $0 /D=$INSTDIR' $1
  ${If} ${Errors}
    System::Call 'kernel32::SetEnvironmentVariableW(w "CHEVOINK_SETUP_LANGUAGE", p 0)'
    System::Call 'kernel32::SetEnvironmentVariableW(w "CHEVOINK_SETUP_SHORTCUT", p 0)'
    BringToFront
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(ChevoinkLanguageError)"
    Return
  ${EndIf}
  ${If} $1 >= 32000
  ${AndIf} $1 <= 32003
    StrCpy $0 1033
    ${If} $1 >= 32002
      StrCpy $0 2052
    ${EndIf}
    IntOp $1 $1 & 1
    Goto chevoink_show_language
  ${EndIf}
  SetErrorLevel $1
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_CLOSE}, p 0, p 0)'
FunctionEnd

Function ChevoinkDirectoryPre
  ${If} $ChevoinkChangePath != 1
    Abort
  ${EndIf}
FunctionEnd

Function ChevoinkBrowseFolder
  Pop $0
  StrCpy $ChevoinkChangePath 1
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${BM_CLICK} 0 0
FunctionEnd

Function ChevoinkToggleOptions
  Pop $0
  ${If} $ChevoinkOptionsOpen == 1
    StrCpy $ChevoinkOptionsOpen 0
  ${Else}
    StrCpy $ChevoinkOptionsOpen 1
  ${EndIf}
  Call ChevoinkShowOptions
FunctionEnd

Function ChevoinkShowOptions
  StrCpy $0 ${SW_HIDE}
  ${NSD_SetText} $ChevoinkOptionsControl "$(ChevoinkOptions)"
  ${If} $ChevoinkOptionsOpen == ${BST_CHECKED}
    StrCpy $0 ${SW_SHOW}
    ${NSD_SetText} $ChevoinkOptionsControl "$(ChevoinkHideOptions)"
  ${EndIf}
  ShowWindow $ChevoinkPathControl $0
  ShowWindow $ChevoinkShortcutControl $0
  ShowWindow $ChevoinkLanguageControl $0
  ${If} $ChevoinkExistingVersion == ""
    ShowWindow $ChevoinkBrowseControl $0
  ${Else}
    ShowWindow $ChevoinkBrowseControl ${SW_HIDE}
  ${EndIf}
FunctionEnd

Function ChevoinkWelcomeLeave
  ${NSD_GetState} $ChevoinkShortcutControl $ChevoinkShortcutChoice
FunctionEnd

Function ChevoinkApplyDesktopShortcut
  ${If} $UpdateMode == 1
  ${OrIf} $NoShortcutMode == 1
    Return
  ${EndIf}
  ${If} $ChevoinkShortcutChoice == ${BST_CHECKED}
    Call CreateOrUpdateDesktopShortcut
  ${Else}
    ; Never remove an unrelated shortcut that happens to have the same name.
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 == 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}
FunctionEnd

!macro CHEVOINK_PAGE_WELCOME
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ChevoinkWelcomeShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE ChevoinkWelcomeLeave
  !define MUI_WELCOMEPAGE_TITLE "$(ChevoinkInstallTitle)"
  !define MUI_WELCOMEPAGE_TEXT ""
  !insertmacro MUI_PAGE_WELCOME

  Function ChevoinkWelcomeShow
    StrCpy $ChevoinkChangePath 0
    ReadRegStr $ChevoinkExistingVersion SHCTX "${UNINSTKEY}" "DisplayVersion"
    StrCpy $0 "$(ChevoinkInstallTitle)"
    StrCpy $1 "$(ChevoinkInstall)"
    StrCpy $2 "$(ChevoinkVersion)"
    ${If} $ChevoinkExistingVersion != ""
      nsis_tauri_utils::SemverCompare "${VERSION}" "$ChevoinkExistingVersion"
      Pop $3
      StrCpy $2 "$(ChevoinkVersions)"
      ${If} $3 == 1
        StrCpy $0 "$(ChevoinkUpdateTitle)"
        StrCpy $1 "$(ChevoinkUpdate)"
      ${ElseIf} $3 == 0
        StrCpy $0 "$(ChevoinkRepairTitle)"
        StrCpy $1 "$(ChevoinkRepair)"
      ${Else}
        StrCpy $0 "$(ChevoinkOlderTitle)"
        StrCpy $1 "$(^NextBtn)"
      ${EndIf}
    ${EndIf}
    ${NSD_SetText} $mui.WelcomePage.Title $0
    ${NSD_SetText} $mui.Button.Next $1
    ; MUI's default body label fills the entire page. Replace it with native
    ; labels sized around the expandable controls, so they remain clickable.
    ShowWindow $mui.WelcomePage.Text ${SW_HIDE}
    ${NSD_CreateLabel} 120u 43u -10u 13u "$2"
    Pop $0
    SetCtlColors $0 "" "${MUI_BGCOLOR}"
    ${NSD_CreateLabel} 120u 60u -10u 15u "$(ChevoinkUser)"
    Pop $0
    SetCtlColors $0 "" "${MUI_BGCOLOR}"

    StrCpy $0 88u
    ${If} $LANGUAGE == 2052
      StrCpy $0 64u
    ${EndIf}
    ${NSD_CreateButton} 120u 84u $0 16u "$(ChevoinkOptions)"
    Pop $ChevoinkOptionsControl
    ${NSD_OnClick} $ChevoinkOptionsControl ChevoinkToggleOptions

    ; SS_PATHELLIPSIS keeps long folders inside one line at any DPI.
    nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_PATHELLIPSIS}|${SS_NOPREFIX}" 0 120u 103u -10u 14u "$(ChevoinkFolder)   $INSTDIR"
    Pop $ChevoinkPathControl
    SetCtlColors $ChevoinkPathControl "" "${MUI_BGCOLOR}"
    ${NSD_CreateButton} 120u 122u 84u 16u "$(ChevoinkChangeFolder)"
    Pop $ChevoinkBrowseControl
    ${NSD_OnClick} $ChevoinkBrowseControl ChevoinkBrowseFolder
    ${NSD_CreateButton} 213u 122u 76u 16u "$(ChevoinkOtherLanguage)"
    Pop $ChevoinkLanguageControl
    ${NSD_OnClick} $ChevoinkLanguageControl ChevoinkSwitchLanguage

    ${NSD_CreateCheckbox} 120u 147u -10u 15u "$(ChevoinkShortcut)"
    Pop $ChevoinkShortcutControl
    SetCtlColors $ChevoinkShortcutControl "" "${MUI_BGCOLOR}"
    ${If} ${IsHighContrastModeActive}
      System::Call 'uxtheme::SetWindowTheme(p $ChevoinkShortcutControl, w " ", w " ")'
    ${EndIf}
    ${If} $ChevoinkShortcutChoice == ""
      StrCpy $ChevoinkShortcutChoice ${BST_CHECKED}
      ${If} $ChevoinkExistingVersion != ""
        !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        Pop $ChevoinkShortcutChoice
      ${EndIf}
    ${EndIf}
    ${If} $NoShortcutMode == 1
    ${OrIf} $UpdateMode == 1
      EnableWindow $ChevoinkShortcutControl 0
      ${If} $NoShortcutMode == 1
        StrCpy $ChevoinkShortcutChoice ${BST_UNCHECKED}
      ${EndIf}
    ${EndIf}
    ${NSD_SetState} $ChevoinkShortcutControl $ChevoinkShortcutChoice
    Call ChevoinkShowOptions
    ${NSD_SetFocus} $mui.Button.Next
  FunctionEnd
!macroend

!macro CHEVOINK_PAGE_FINISH
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ChevoinkFinishShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE ChevoinkFinishLeave
  !define MUI_FINISHPAGE_TITLE "$(ChevoinkReady)"
  !define MUI_FINISHPAGE_TEXT "$(ChevoinkVersion)"
  !define MUI_FINISHPAGE_BUTTON "$(ChevoinkOpen)"
  !define MUI_FINISHPAGE_REBOOTLATER_DEFAULT
  !insertmacro MUI_PAGE_FINISH

  Function ChevoinkFinishShow
    ; Closing the final page is successful even when NSIS routes X / Esc
    ; through its cancel handler. Set only after install sections succeeded.
    SetErrorLevel 0
    EnableWindow $mui.Button.Cancel 1
    ${If} $ChevoinkExistingVersion != ""
    ${AndIf} $ChevoinkExistingVersion != "${VERSION}"
      ${NSD_SetText} $mui.FinishPage.Title "$(ChevoinkUpdated)"
    ${EndIf}
    ${NSD_SetText} $mui.Button.Cancel "$(ChevoinkClose)"
    ${If} ${RebootFlag}
      ${NSD_SetText} $mui.Button.Next "$(MUI_BUTTONTEXT_FINISH)"
    ${EndIf}
  FunctionEnd

  Function ChevoinkFinishLeave
    ${IfNot} ${RebootFlag}
      Call RunMainBinary
    ${EndIf}
  FunctionEnd
!macroend
