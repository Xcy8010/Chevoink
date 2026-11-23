!insertmacro ChevoinkText Running "启创墨域正在运行" "Chevoink is open"
!insertmacro ChevoinkText SaveFirst "请先保存作品，再正常退出启创墨域。关闭后可继续安装。" "Save your work and quit Chevoink, then continue setup."
!insertmacro ChevoinkText ReturnToApp "返回应用" "Return to &app"
!insertmacro ChevoinkText Continue "关闭后继续" "&Continue after closing"
!insertmacro ChevoinkText CloseFirst "请保存作品并关闭启创墨域，然后重试。" "Save your work and close Chevoink, then retry."
!insertmacro ChevoinkText RuntimeError "无法下载 Windows 运行组件" "Couldn't download the Windows runtime"
!insertmacro ChevoinkText RuntimeInstallError "无法安装 Windows 运行组件" "Couldn't install the Windows runtime"
!insertmacro ChevoinkText RuntimeHelp "请检查网络连接，或从启创墨域下载页获取内置 WebView2 的安装包。" "Check your connection, or get the installer with WebView2 included from the Chevoink downloads page."
!insertmacro ChevoinkText Retry "重试下载" "Retry download"
!insertmacro ChevoinkText CheckRuntime "正在检查 Windows 运行组件" "Checking the Windows runtime"
!insertmacro ChevoinkText InstallFiles "正在安装启创墨域应用文件" "Installing Chevoink application files"
!insertmacro ChevoinkText Finalize "正在完成安装" "Finishing setup"
!insertmacro ChevoinkText Offline "前往下载内置组件版" "Get the installer with WebView2"

Function ChevoinkWriterPage
  Call SkipIfPassive
  nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 != 0
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(ChevoinkRunning)" "$(ChevoinkCloseFirst)"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 8u 100% 32u "$(ChevoinkSaveFirst)"
  Pop $0
  ${NSD_CreateButton} 0 49u 85u 18u "$(ChevoinkReturnToApp)"
  Pop $0
  ${NSD_OnClick} $0 ChevoinkReturnToApp
  GetDlgItem $0 $HWNDPARENT 1
  ${NSD_SetText} $0 "$(ChevoinkContinue)"
  nsDialogs::Show
FunctionEnd

Function ChevoinkReturnToApp
  Pop $0
  ShowWindow $HWNDPARENT ${SW_MINIMIZE}
  FindWindow $0 "" "${PRODUCTNAME}"
  ${If} $0 != 0
    System::Call 'user32::IsIconic(p r0)i.r1'
    ${If} $1 != 0
      ShowWindow $0 ${SW_RESTORE}
    ${EndIf}
    System::Call 'user32::SetForegroundWindow(p r0)'
  ${EndIf}
FunctionEnd

Function ChevoinkWriterLeave
  nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 == 0
    MessageBox MB_OK|MB_ICONINFORMATION "$(ChevoinkCloseFirst)"
    Abort
  ${EndIf}
FunctionEnd

; Also protect unattended installs/uninstalls and an app reopened during setup.
!macro ChevoinkRequireClosed
  chevoink_check_running:
    nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 == 0
      ${If} $PassiveMode != 1
      ${AndIfNot} ${Silent}
        MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "$(ChevoinkCloseFirst)" IDRETRY chevoink_check_running
      ${EndIf}
      SetErrorLevel 2
      Abort "$(ChevoinkCloseFirst)"
    ${EndIf}
!macroend

; Native command links keep both recovery actions accessible to keyboard and
; screen readers. Tauri uses an x86-unicode NSIS stub for its x64 app bundle.
Var ChevoinkRecoveryChoice
Var ChevoinkRuntimeIssue
Function ChevoinkRuntimeFailed
  StrCpy $0 2
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Return
  ${EndIf}
  System::Store S
  System::Call 'shlwapi::SHStrDupW(w "$ChevoinkRuntimeIssue", *p .r1)'
  System::Call 'shlwapi::SHStrDupW(w "$(ChevoinkRuntimeHelp)", *p .r2)'
  System::Call 'shlwapi::SHStrDupW(w "$(ChevoinkRetry)", *p .r3)'
  System::Call 'shlwapi::SHStrDupW(w "$(ChevoinkOffline)", *p .r4)'
  System::Call 'shlwapi::SHStrDupW(w "Chevoink", *p .r9)'
  System::Call '*(i 100,p r3,i 101,p r4)p.r5'
  ; TASKDIALOGCONFIG: owner, command links, cancel, title, two buttons, default retry.
  System::Call '*(i 96,p $HWNDPARENT,p 0,i 4120,i 8,p r9,p 0,p r1,p r2,i 2,p r5,i 100,i 0,p 0,i 0,p 0,p 0,p 0,p 0,p 0,p 0,p 0,p 0,i 0)p.r6'
  System::Call 'comctl32::TaskDialogIndirect(p r6,*i .r7,p 0,p 0)i.r8'
  ${If} $8 != 0
    StrCpy $7 2
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$ChevoinkRuntimeIssue$\r$\n$(ChevoinkRuntimeHelp)" IDCANCEL +2
    StrCpy $7 100
  ${EndIf}
  System::Free $6
  System::Free $5
  System::Call 'ole32::CoTaskMemFree(p r9)'
  System::Call 'ole32::CoTaskMemFree(p r4)'
  System::Call 'ole32::CoTaskMemFree(p r3)'
  System::Call 'ole32::CoTaskMemFree(p r2)'
  System::Call 'ole32::CoTaskMemFree(p r1)'
  StrCpy $ChevoinkRecoveryChoice $7
  System::Store L
  StrCpy $0 $ChevoinkRecoveryChoice
  ${If} $0 == 101
    ExecShell "open" "https://github.com/Xcy8010/Chevoink/releases/latest"
  ${EndIf}
FunctionEnd
