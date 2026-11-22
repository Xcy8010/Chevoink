use crate::navigation::{is_app_url, is_download_url, opens_in_browser, safe_filename, APP_ORIGIN};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::{cell::RefCell, path::Path};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use webview2_com::{
    take_pwstr, AcceleratorKeyPressedEventHandler, ContainsFullScreenElementChangedEventHandler,
    DownloadStartingEventHandler, Microsoft::Web::WebView2::Win32::*,
    NavigationCompletedEventHandler, NewWindowRequestedEventHandler,
    PermissionRequestedEventHandler, ProcessFailedEventHandler, StateChangedEventHandler,
};
use windows::core::{Interface, BOOL, HSTRING, PWSTR};

/// Windows-specific permission/navigation/crash hooks are kept here, not in the web UI.
pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    let owned = window.clone();
    window.with_webview(move |platform| {
        // SAFETY: all COM interfaces and handlers are created/used on the WebView UI thread.
        // Strings returned by WebView2 are consumed with take_pwstr (CoTaskMemFree).
        let install = || -> windows::core::Result<()> { unsafe {
            let webview = platform.controller().CoreWebView2()?;
            let settings: ICoreWebView2Settings2 = webview.Settings()?.cast()?;
            let mut ua = PWSTR::null();
            settings.UserAgent(&mut ua)?;
            let ua = format!("{} ChevoinkDesktop/{}", take_pwstr(ua), env!("CARGO_PKG_VERSION"));
            settings.SetUserAgent(&HSTRING::from(ua))?;
            let permission_window = owned.clone();
            let mut token = 0;
            install_downloads(&webview, &owned)?;
            let keyboard_fullscreen = Arc::new(AtomicBool::new(false));
            let fullscreen_window = owned.clone();
            let fullscreen_mode = keyboard_fullscreen.clone();
            webview.add_ContainsFullScreenElementChanged(&ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(sender) = sender {
                    let mut contains = BOOL::default();
                    sender.ContainsFullScreenElement(&mut contains)?;
                    let _ = fullscreen_window.set_fullscreen(contains.as_bool() || fullscreen_mode.load(Ordering::SeqCst));
                }
                Ok(())
            })), &mut token)?;
            let key_window = owned.clone();
            platform.controller().add_AcceleratorKeyPressed(&AcceleratorKeyPressedEventHandler::create(Box::new(move |sender, args| {
                let (Some(sender), Some(args)) = (sender, args) else { return Ok(()); };
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default(); args.KeyEventKind(&mut kind)?;
                let mut key = 0; args.VirtualKey(&mut key)?;
                if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN || !matches!(key, 0x7A | 0x1B) { return Ok(()); }
                let mut contains = BOOL::default(); sender.CoreWebView2()?.ContainsFullScreenElement(&mut contains)?;
                let fullscreen = key_window.is_fullscreen().unwrap_or(false);
                // Escape first belongs to DOM fullscreen/dialogs; intercept only host-only fullscreen.
                if key == 0x1B && (!fullscreen || contains.as_bool()) { return Ok(()); }
                args.SetHandled(true)?;
                let mut lparam = 0; args.KeyEventLParam(&mut lparam)?;
                if lparam & (1 << 30) != 0 { return Ok(()); }
                let next = key == 0x7A && !fullscreen;
                keyboard_fullscreen.store(next, Ordering::SeqCst);
                if !next && contains.as_bool() {
                    let _ = key_window.eval("if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});");
                }
                let _ = key_window.set_fullscreen(next);
                Ok(())
            })), &mut token)?;
            webview.add_PermissionRequested(&PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()); };
                let mut uri = PWSTR::null(); args.Uri(&mut uri)?;
                let origin = url::Url::parse(&take_pwstr(uri)).is_ok_and(|url| is_app_url(&url));
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default(); args.PermissionKind(&mut kind)?;
                let mut gesture = BOOL::default(); args.IsUserInitiated(&mut gesture)?;
                let allow_prompt = origin && gesture.as_bool() && permission_window.is_focused().unwrap_or(false)
                    && kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE;
                args.SetState(if allow_prompt { COREWEBVIEW2_PERMISSION_STATE_DEFAULT } else { COREWEBVIEW2_PERMISSION_STATE_DENY })?;
                Ok(())
            })), &mut token)?;
            let app = owned.app_handle().clone();
            webview.add_NewWindowRequested(&NewWindowRequestedEventHandler::create(Box::new(move |sender, args| {
                let (Some(sender), Some(args)) = (sender, args) else { return Ok(()); };
                args.SetHandled(true)?;
                let mut gesture = BOOL::default(); args.IsUserInitiated(&mut gesture)?;
                if !gesture.as_bool() { return Ok(()); }
                // Read the COM sender directly on its UI thread.
                let mut source = PWSTR::null(); sender.Source(&mut source)?;
                if !url::Url::parse(&take_pwstr(source)).is_ok_and(|url| is_app_url(&url)) { return Ok(()); }
                let mut uri = PWSTR::null(); args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                if let Ok(url) = url::Url::parse(&uri) {
                    if opens_in_browser(&url) {
                        match app.opener().open_url(url.as_str(), None::<&str>) {
                            Ok(()) => eprintln!("Desktop link handed to default browser"),
                            Err(_) => crate::window::notice("未能打开链接", "请检查 Windows 默认浏览器设置后重试。"),
                        }
                    } else if is_app_url(&url) {
                        sender.Navigate(&HSTRING::from(uri))?;
                    }
                }
                Ok(())
            })), &mut token)?;
            let loaded = Arc::new(AtomicBool::new(false));
            let boot_started = AtomicBool::new(false);
            let load_window = owned.clone();
            webview.add_NavigationCompleted(&NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
                let (Some(sender), Some(args)) = (sender, args) else { return Ok(()); };
                let mut uri = PWSTR::null(); sender.Source(&mut uri)?;
                let location = url::Url::parse(&take_pwstr(uri)).ok();
                let remote = location.as_ref().is_some_and(is_app_url);
                let mut success = BOOL::default(); args.IsSuccess(&mut success)?;
                if success.as_bool() && location.as_ref().is_some_and(|url| crate::navigation::is_fallback_url(url) && url.fragment().is_none())
                    && !boot_started.swap(true, Ordering::SeqCst) {
                    sender.Navigate(&HSTRING::from(APP_ORIGIN))?;
                    return Ok(());
                }
                if remote && success.as_bool() { loaded.store(true, Ordering::SeqCst); }
                else if remote && !success.as_bool() && !loaded.load(Ordering::SeqCst) {
                    let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                    args.WebErrorStatus(&mut status)?;
                    // Replacing the initial local page deliberately cancels its navigation.
                    // It must not cancel the new remote load by navigating back to fallback.
                    if let Some(reason) = failure_reason(status) {
                        let _ = load_window.navigate(format!("http://tauri.localhost/#{reason}").parse().unwrap());
                    }
                }
                Ok(())
            })), &mut token)?;
            let crashes = Arc::new(AtomicUsize::new(0));
            let crash_window = owned.clone();
            webview.add_ProcessFailed(&ProcessFailedEventHandler::create(Box::new(move |_, _| {
                if crashes.fetch_add(1, Ordering::SeqCst) == 0 { let _ = crash_window.reload(); }
                else {
                    let _ = crash_window.navigate("http://tauri.localhost/#crash".parse().unwrap());
                    crate::window::notice("页面进程异常", "已停止自动重载。请重新打开客户端；已保存资料保留，不会重新发送任务。");
                }
                Ok(())
            })), &mut token)?;
            // Commit the packaged web boot DOM before its first remote navigation.
            // This also covers an initial local navigation that finished before hooks installed.
            webview.Navigate(&HSTRING::from("http://tauri.localhost/index.html"))?;
            Ok(())
        }};
        if install().is_err() {
            let _ = owned.navigate("http://tauri.localhost/#engine".parse().unwrap());
            // Fail closed: no remote page is loaded without the complete permission policy.
            crate::window::notice("Windows 内核初始化失败", "无法建立安全的浏览器环境，请更新 WebView2 后重试。未连接创作任务。");
        }
    })
}

struct PendingSaveDialog {
    args: ICoreWebView2DownloadStartingEventArgs,
    deferral: ICoreWebView2Deferral,
    finished: Arc<AtomicBool>,
}
// COM pointers never cross apartments. Only the selected path returns from the dialog thread.
thread_local! {
    static SAVE_DIALOG: RefCell<Option<PendingSaveDialog>> = const { RefCell::new(None) };
}

fn finish_download(window: &WebviewWindow, finished: &AtomicBool, failed: bool) {
    if !finished.swap(true, Ordering::SeqCst) {
        let _ = window
            .state::<crate::window::CloseState>()
            .downloads
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                Some(count.saturating_sub(1))
            });
        if failed {
            crate::window::notice("下载未完成", "文件未完整保存，请重试。原作品不受影响。");
        }
    }
}

unsafe fn install_downloads(
    webview: &ICoreWebView2,
    window: &WebviewWindow,
) -> windows::core::Result<()> {
    let window = window.clone();
    let download_view: ICoreWebView2_4 = webview.cast()?;
    let mut token = 0;
    download_view.add_DownloadStarting(
        &DownloadStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let operation = args.DownloadOperation()?;
            let mut uri = PWSTR::null();
            operation.Uri(&mut uri)?;
            let allowed = url::Url::parse(&take_pwstr(uri)).is_ok_and(|url| is_download_url(&url))
                && window.url().is_ok_and(|url| is_app_url(&url));
            if !allowed
                || SAVE_DIALOG.with(|slot| slot.borrow().is_some())
                || window
                    .state::<crate::window::CloseState>()
                    .downloads
                    .load(Ordering::SeqCst)
                    >= 8
            {
                args.SetCancel(true)?;
                return Ok(());
            }
            let mut path = PWSTR::null();
            args.ResultFilePath(&mut path)?;
            let path = take_pwstr(path);
            let name = safe_filename(
                Path::new(&path)
                    .file_name()
                    .and_then(|v| v.to_str())
                    .unwrap_or("Chevoink-export.txt"),
            );
            let finished = Arc::new(AtomicBool::new(false));
            let completion = finished.clone();
            let completion_window = window.clone();
            operation.add_StateChanged(
                &StateChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(sender) = sender {
                        let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
                        sender.State(&mut state)?;
                        if state != COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS {
                            finish_download(
                                &completion_window,
                                &completion,
                                state != COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED,
                            );
                        }
                    }
                    Ok(())
                })),
                &mut 0,
            )?;
            args.SetHandled(true)?;
            let deferral = args.GetDeferral()?;
            window
                .state::<crate::window::CloseState>()
                .downloads
                .fetch_add(1, Ordering::SeqCst);
            SAVE_DIALOG.with(|slot| {
                *slot.borrow_mut() = Some(PendingSaveDialog {
                    args,
                    deferral,
                    finished,
                })
            });
            let dialog_window = window.clone();
            std::thread::spawn(move || {
                let selected = rfd::FileDialog::new().set_file_name(name).save_file();
                let callback_window = dialog_window.clone();
                let _ = dialog_window.run_on_main_thread(move || {
                    SAVE_DIALOG.with(|slot| {
                        let pending = slot.borrow_mut().take();
                        if let Some(pending) = pending {
                            // SAFETY: back on DownloadStarting's UI/COM apartment, without a held RefCell borrow.
                            let result = selected.as_ref().map(|path| {
                                pending
                                    .args
                                    .SetResultFilePath(&HSTRING::from(path.as_os_str()))
                            });
                            if !matches!(result, Some(Ok(()))) {
                                finish_download(
                                    &callback_window,
                                    &pending.finished,
                                    result.is_some(),
                                );
                                let _ = pending.args.SetCancel(true);
                            }
                            if pending.deferral.Complete().is_err() {
                                finish_download(&callback_window, &pending.finished, true);
                            }
                        }
                    });
                });
            });
            Ok(())
        })),
        &mut token,
    )?;
    Ok(())
}

fn failure_reason(status: COREWEBVIEW2_WEB_ERROR_STATUS) -> Option<&'static str> {
    match status {
        COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED => None,
        COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED => Some("dns"),
        COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT => Some("timeout"),
        COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT
        | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED
        | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID
        | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED
        | COREWEBVIEW2_WEB_ERROR_STATUS_CLIENT_CERTIFICATE_CONTAINS_ERRORS => Some("tls"),
        _ => Some("network"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_is_not_a_startup_failure_and_tls_is_not_a_generic_network_error() {
        assert_eq!(
            failure_reason(COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED),
            None
        );
        assert_eq!(
            failure_reason(COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED),
            Some("tls")
        );
        assert_eq!(
            failure_reason(COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED),
            Some("dns")
        );
        assert_eq!(
            failure_reason(COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT),
            Some("timeout")
        );
    }
}
