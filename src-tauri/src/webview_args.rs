
const BASE_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,",
    "SpareRendererForSitePerProcess,",
    "InterestFeedContentSuggestions,MediaRouter,OptimizationHints,Translate,",
    "AutofillServerCommunication,CertificateTransparencyComponentUpdater,",
    "SegmentationPlatform,BackgroundFetch ",
    "--autoplay-policy=no-user-gesture-required ",
    "--no-first-run --no-default-browser-check --disable-sync ",
    "--disable-background-networking --disable-component-update ",
    "--disable-domain-reliability --disable-breakpad ",
    "--disk-cache-size=16777216 --media-cache-size=8388608 ",
    "--enable-low-end-device-mode ",
    "--js-flags=--max-semi-space-size=1 ",
    "--renderer-process-limit=1 ",
    "--num-raster-threads=2"
);

pub fn arguments() -> String {
    BASE_ARGS.to_string()
}

pub fn apply() {
    if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_some() {
        return;
    }
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", arguments());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_args_keep_the_wry_defaults() {
        assert!(BASE_ARGS.contains("msWebOOUI"));
        assert!(BASE_ARGS.contains("msPdfOOUI"));
        assert!(BASE_ARGS.contains("msSmartScreenProtection"));
        assert!(BASE_ARGS.contains("--autoplay-policy=no-user-gesture-required"));
    }

    #[test]
    fn feature_list_is_a_single_flag() {
        assert_eq!(BASE_ARGS.matches("--disable-features=").count(), 1);
    }
}
