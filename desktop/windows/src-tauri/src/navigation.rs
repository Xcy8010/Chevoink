use url::Url;

pub const APP_ORIGIN: &str = "https://chevoink.chevolink.com";

pub fn is_fallback_url(url: &Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("http", Some("tauri.localhost")) | ("tauri", Some("localhost"))
    ) && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "/" | "/index.html")
        && url.query().is_none()
        && matches!(
            url.fragment(),
            None | Some("dns" | "tls" | "timeout" | "network" | "crash" | "engine")
        )
}

pub fn is_app_url(url: &Url) -> bool {
    url.origin().ascii_serialization() == APP_ORIGIN
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn is_external_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn opens_in_browser(url: &Url) -> bool {
    is_external_url(url)
        && (!is_app_url(url) || url.path() == "/account" || url.path().starts_with("/account/"))
}

pub fn is_download_url(url: &Url) -> bool {
    is_app_url(url)
        || (url.scheme() == "blob" && Url::parse(url.path()).is_ok_and(|inner| is_app_url(&inner)))
}

pub fn safe_filename(name: &str) -> String {
    let clean: String = name
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .take(160)
        .collect();
    let clean = clean.trim().trim_end_matches(['.', ' ']);
    let stem = clean.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if clean.is_empty() || reserved {
        "Chevoink-export.txt".into()
    } else {
        clean.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fallback_navigation_has_no_arbitrary_path_or_parameters() {
        assert!(is_fallback_url(
            &Url::parse("http://tauri.localhost/#tls").unwrap()
        ));
        for value in [
            "http://tauri.localhost/other",
            "http://tauri.localhost:8888/",
            "http://tauri.localhost/?url=https://evil.test",
            "http://tauri.localhost/#<script>",
            "http://user@tauri.localhost/",
        ] {
            assert!(!is_fallback_url(&Url::parse(value).unwrap()));
        }
    }
    #[test]
    fn origin_is_exact_and_never_a_prefix() {
        assert!(is_app_url(
            &Url::parse(&format!("{APP_ORIGIN}/studio?x=1")).unwrap()
        ));
        for value in [
            "https://chevoink.chevolink.com.evil.test",
            "http://chevoink.chevolink.com",
            "https://chevoink.chevolink.com:444",
            "https://user@chevoink.chevolink.com",
            "file:///C:/test",
            "javascript:alert(1)",
        ] {
            assert!(!is_app_url(&Url::parse(value).unwrap()), "{value}");
        }
    }
    #[test]
    fn browser_links_include_account_pages_but_keep_other_app_routes_internal() {
        let site = Url::parse(APP_ORIGIN).unwrap();
        for path in ["/account", "/account/", "/account/docs?doc=faq#security"] {
            assert!(opens_in_browser(&site.join(path).unwrap()));
        }
        for path in ["/accounting", "/studio", "/api/auth/account/profile"] {
            assert!(!opens_in_browser(&site.join(path).unwrap()));
        }
        let book = Url::parse("https://example.org/book").unwrap();
        assert!(opens_in_browser(&book));
        for url in [
            "javascript:void(0)",
            "file:///C:/test",
            "https://u:p@example.org",
        ] {
            assert!(!opens_in_browser(&Url::parse(url).unwrap()));
        }
    }
    #[test]
    fn blob_download_is_bound_to_app_origin() {
        assert!(is_download_url(
            &Url::parse("blob:https://chevoink.chevolink.com/123").unwrap()
        ));
        assert!(!is_download_url(
            &Url::parse("blob:https://evil.test/123").unwrap()
        ));
    }
    #[test]
    fn filenames_cannot_escape_or_use_devices() {
        assert_eq!(safe_filename("CON.txt"), "Chevoink-export.txt");
        assert_eq!(safe_filename("LPT1"), "Chevoink-export.txt");
        assert_eq!(safe_filename("第25章.txt"), "第25章.txt");
        assert!(!safe_filename("../../evil.exe").contains('/'));
        assert_eq!(safe_filename("  ... "), "Chevoink-export.txt");
    }
}
