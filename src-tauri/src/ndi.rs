// Native NDI sender. Loads libndi at runtime via libloading so we don't have
// to bundle the NewTek SDK or deal with redistribution licensing — users
// install NDI Tools (free, ubiquitous in pro AV) and KAIRO finds the dylib
// at standard install paths.
//
// Frame rendering is done in pure Rust with tiny-skia + cosmic-text: no
// webview capture, no platform-specific screen-capture APIs. A background
// thread re-renders only when verse text changes and pushes frames to NDI
// at a low cadence (NDI receivers tolerate any rate; we use 15fps for
// efficiency since static text doesn't need 60fps).

use std::ffi::{c_void, CString};
use std::os::raw::{c_char, c_int};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crossbeam_channel::{bounded, Sender};
use libloading::{Library, Symbol};

const FRAME_W: i32 = 1280;
const FRAME_H: i32 = 720;
const SEND_FPS_N: i32 = 15;     // Frame-rate numerator (15/1 = 15 fps)
const SEND_FPS_D: i32 = 1;
// FourCC for BGRA = ('B','G','R','A') little-endian = 0x41524742
const FOURCC_BGRA: u32 = 0x4152_4742;

// ── Minimal NDI C ABI ─────────────────────────────────────────────────────
// We only need the four functions to publish video. All struct field offsets
// must match libndi's headers exactly.

#[repr(C)]
struct NdiSendCreateT {
    p_ndi_name: *const c_char,
    p_groups:   *const c_char,
    clock_video: bool,
    clock_audio: bool,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
enum NdiFrameFormat {
    Progressive = 1,
}

#[repr(C)]
struct NdiVideoFrameV2T {
    xres: c_int,
    yres: c_int,
    fourcc: u32,
    frame_rate_n: c_int,
    frame_rate_d: c_int,
    picture_aspect_ratio: f32,
    frame_format_type: c_int,    // NdiFrameFormat::Progressive = 1
    timecode: i64,
    p_data: *const u8,
    line_stride_in_bytes: c_int, // we use this when fourcc is uncompressed
    p_metadata: *const c_char,
    timestamp: i64,
}

type NdiInitializeFn      = unsafe extern "C" fn() -> bool;
type NdiDestroyFn         = unsafe extern "C" fn();
type NdiSendCreateFn      = unsafe extern "C" fn(*const NdiSendCreateT) -> *mut c_void;
type NdiSendDestroyFn     = unsafe extern "C" fn(*mut c_void);
type NdiSendSendVideoV2Fn = unsafe extern "C" fn(*mut c_void, *const NdiVideoFrameV2T);

struct LibNdi {
    _lib: Library,
    initialize:   unsafe extern "C" fn() -> bool,
    destroy:      unsafe extern "C" fn(),
    send_create:  unsafe extern "C" fn(*const NdiSendCreateT) -> *mut c_void,
    send_destroy: unsafe extern "C" fn(*mut c_void),
    send_video:   unsafe extern "C" fn(*mut c_void, *const NdiVideoFrameV2T),
}

impl LibNdi {
    /// Try every known NDI install location, return the first one that loads.
    fn try_load() -> Option<Self> {
        for path in candidate_libndi_paths() {
            if let Some(lib) = unsafe { Library::new(&path) }.ok() {
                if let Some(loaded) = Self::resolve_symbols(lib) {
                    eprintln!("[NDI] Loaded libndi from {}", path.display());
                    return Some(loaded);
                }
            }
        }
        None
    }

    fn resolve_symbols(lib: Library) -> Option<Self> {
        unsafe {
            let initialize:   Symbol<NdiInitializeFn>      = lib.get(b"NDIlib_initialize\0").ok()?;
            let destroy:      Symbol<NdiDestroyFn>         = lib.get(b"NDIlib_destroy\0").ok()?;
            let send_create:  Symbol<NdiSendCreateFn>      = lib.get(b"NDIlib_send_create\0").ok()?;
            let send_destroy: Symbol<NdiSendDestroyFn>     = lib.get(b"NDIlib_send_destroy\0").ok()?;
            let send_video:   Symbol<NdiSendSendVideoV2Fn> = lib.get(b"NDIlib_send_send_video_v2\0").ok()?;
            Some(LibNdi {
                initialize:   *initialize,
                destroy:      *destroy,
                send_create:  *send_create,
                send_destroy: *send_destroy,
                send_video:   *send_video,
                _lib: lib,
            })
        }
    }
}

/// Standard NDI install locations across platforms. We probe each one and use
/// the first dylib that successfully loads + resolves symbols.
fn candidate_libndi_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        paths.push("/Library/NDI SDK for Apple/lib/macOS/libndi.dylib".into());
        paths.push("/Library/Application Support/NewTek/NDI Tools/Frameworks/libndi.dylib".into());
        paths.push("/Library/Application Support/NewTek/NDI Tools/NDI Tools.app/Contents/Frameworks/libndi.dylib".into());
        paths.push("/usr/local/lib/libndi.dylib".into());
        paths.push("/opt/homebrew/lib/libndi.dylib".into());
        // Bare name lets dlopen search DYLD_LIBRARY_PATH if user set it.
        paths.push("libndi.dylib".into());
    }
    #[cfg(target_os = "windows")]
    {
        // Default install path uses %ProgramFiles%\NDI\NDI 6 SDK\Bin\x64
        if let Ok(pf) = std::env::var("ProgramFiles") {
            paths.push(format!("{}\\NDI\\NDI 6 SDK\\Bin\\x64\\Processing.NDI.Lib.x64.dll", pf).into());
            paths.push(format!("{}\\NDI\\NDI 5 SDK\\Bin\\x64\\Processing.NDI.Lib.x64.dll", pf).into());
            paths.push(format!("{}\\NewTek\\NDI 6 Runtime\\v6\\Processing.NDI.Lib.x64.dll", pf).into());
            paths.push(format!("{}\\NewTek\\NDI 5 Runtime\\v5\\Processing.NDI.Lib.x64.dll", pf).into());
        }
        paths.push("Processing.NDI.Lib.x64.dll".into());
    }
    #[cfg(target_os = "linux")]
    {
        paths.push("/usr/share/NDI SDK for Linux/lib/x86_64-linux-gnu/libndi.so".into());
        paths.push("/usr/lib/x86_64-linux-gnu/libndi.so".into());
        paths.push("/usr/local/lib/libndi.so".into());
        paths.push("libndi.so".into());
    }
    paths
}

// ── Render-and-send worker ────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub enum NdiCmd {
    SetText { verse: String, reference: String },
    Stop,
}

#[derive(Default)]
pub struct NdiHandle {
    tx: Option<Sender<NdiCmd>>,
}

impl NdiHandle {
    pub fn update(&self, verse: String, reference: String) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(NdiCmd::SetText { verse, reference });
        }
    }
    pub fn stop(&mut self) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(NdiCmd::Stop);
        }
    }
    pub fn is_running(&self) -> bool { self.tx.is_some() }
}

pub fn is_libndi_available() -> bool {
    LibNdi::try_load().is_some()
}

/// Start the NDI sender on a background thread. Returns Err if libndi can't
/// be loaded — the caller surfaces this to the UI as a friendly install hint.
pub fn start(source_name: &str, shared: Arc<Mutex<NdiHandle>>) -> Result<(), String> {
    let lib = LibNdi::try_load()
        .ok_or_else(|| "NDI runtime not found. Install NDI Tools from ndi.video/tools (free) and try again.".to_string())?;

    let (tx, rx) = bounded::<NdiCmd>(64);

    let name = source_name.to_string();
    thread::spawn(move || {
        unsafe {
            if !(lib.initialize)() {
                eprintln!("[NDI] NDIlib_initialize() returned false — aborting sender thread.");
                return;
            }

            let cname = match CString::new(name.as_str()) {
                Ok(c) => c,
                Err(_) => CString::new("KAIRO Scripture").unwrap(),
            };
            let create = NdiSendCreateT {
                p_ndi_name: cname.as_ptr(),
                p_groups:   std::ptr::null(),
                clock_video: true,
                clock_audio: false,
            };
            let sender = (lib.send_create)(&create);
            if sender.is_null() {
                eprintln!("[NDI] send_create returned null — aborting.");
                (lib.destroy)();
                return;
            }
            eprintln!("[NDI] Sender '{}' created — broadcasting {}x{} @ {}fps", name, FRAME_W, FRAME_H, SEND_FPS_N);

            // Persistent BGRA buffer we re-render into.
            let mut buf: Vec<u8> = vec![0u8; (FRAME_W * FRAME_H * 4) as usize];
            let mut latest_verse = String::new();
            let mut latest_ref   = String::new();
            // Render initial empty/idle frame
            render_frame(&mut buf, &latest_verse, &latest_ref);

            let frame_period = Duration::from_millis(1000 / SEND_FPS_N as u64);
            loop {
                // Drain pending commands (latest update wins; stop terminates).
                let mut should_stop = false;
                let mut got_update  = false;
                while let Ok(cmd) = rx.try_recv() {
                    match cmd {
                        NdiCmd::Stop => { should_stop = true; break; }
                        NdiCmd::SetText { verse, reference } => {
                            latest_verse = verse;
                            latest_ref   = reference;
                            got_update   = true;
                        }
                    }
                }
                if should_stop { break; }
                if got_update {
                    render_frame(&mut buf, &latest_verse, &latest_ref);
                }

                // Send the current frame.
                let frame = NdiVideoFrameV2T {
                    xres: FRAME_W,
                    yres: FRAME_H,
                    fourcc: FOURCC_BGRA,
                    frame_rate_n: SEND_FPS_N,
                    frame_rate_d: SEND_FPS_D,
                    picture_aspect_ratio: FRAME_W as f32 / FRAME_H as f32,
                    frame_format_type: 1, // progressive
                    timecode: i64::MIN,    // NDI_SEND_TIMECODE_SYNTHESIZE
                    p_data: buf.as_ptr(),
                    line_stride_in_bytes: FRAME_W * 4,
                    p_metadata: std::ptr::null(),
                    timestamp: 0,
                };
                (lib.send_video)(sender, &frame);

                thread::sleep(frame_period);
            }

            eprintln!("[NDI] Stopping sender '{}'", name);
            (lib.send_destroy)(sender);
            (lib.destroy)();
        }
    });

    if let Ok(mut g) = shared.lock() {
        g.tx = Some(tx);
    }
    Ok(())
}

// ── Frame renderer ────────────────────────────────────────────────────────
// Pure Rust 2D rendering with tiny-skia + cosmic-text. Black background,
// red brand accent on the reference, white verse below. Lower-third style.

fn render_frame(buf: &mut [u8], verse: &str, reference: &str) {
    use cosmic_text::{Color as CtColor, FontSystem, SwashCache};
    use tiny_skia::{Color as SkColor, Pixmap, Rect, Transform};

    // Skia pixmap that aliases our shared buffer. We re-use the same allocation
    // every frame to avoid GC churn.
    let mut pixmap = Pixmap::new(FRAME_W as u32, FRAME_H as u32).unwrap();
    pixmap.fill(SkColor::from_rgba8(0, 0, 0, 230));

    // A subtle bottom 38% darker band for lower-third feel. Matches the
    // visual style of the in-app lower-third themes.
    let mut band_paint = tiny_skia::Paint::default();
    band_paint.set_color(SkColor::from_rgba8(10, 14, 20, 255));
    band_paint.anti_alias = false;
    let band_h = (FRAME_H as f32 * 0.38) as f32;
    let band   = Rect::from_xywh(0.0, FRAME_H as f32 - band_h, FRAME_W as f32, band_h).unwrap();
    pixmap.fill_rect(band, &band_paint, Transform::identity(), None);

    // Text: render with cosmic-text into the pixmap. We treat each glyph as
    // an alpha mask drawn with the layer's color.
    let mut font_system = FontSystem::new();
    let mut swash_cache = SwashCache::new();

    // Reference — small, uppercase-style (caller should pass uppercase).
    if !reference.is_empty() {
        draw_text(
            &mut pixmap, &mut font_system, &mut swash_cache,
            reference,
            "sans-serif", 28.0, 700,
            CtColor::rgb(232, 64, 74), // brand red
            72.0, FRAME_H as f32 - band_h + 32.0,
            FRAME_W as f32 - 144.0,
        );
    }
    // Verse — larger, white.
    if !verse.is_empty() {
        draw_text_wrapped(
            &mut pixmap, &mut font_system, &mut swash_cache,
            verse,
            "sans-serif", 40.0, 500,
            CtColor::rgb(255, 255, 255),
            72.0, FRAME_H as f32 - band_h + 90.0,
            FRAME_W as f32 - 144.0,
        );
    }

    // Skia stores RGBA premul; NDI BGRA expects byte-order B,G,R,A. Swap.
    let src = pixmap.data();
    let n   = (FRAME_W * FRAME_H) as usize * 4;
    let copy_len = n.min(src.len()).min(buf.len());
    for i in 0..(copy_len / 4) {
        let r = src[i * 4 + 0];
        let g = src[i * 4 + 1];
        let b = src[i * 4 + 2];
        let a = src[i * 4 + 3];
        buf[i * 4 + 0] = b;
        buf[i * 4 + 1] = g;
        buf[i * 4 + 2] = r;
        buf[i * 4 + 3] = a;
    }
    // Helpers for text drawing
    fn draw_text(
        pixmap: &mut tiny_skia::Pixmap,
        font_system: &mut cosmic_text::FontSystem,
        swash: &mut cosmic_text::SwashCache,
        text: &str,
        family: &str,
        size: f32,
        weight: u16,
        color: cosmic_text::Color,
        x: f32, y: f32, max_w: f32,
    ) {
        let metrics = cosmic_text::Metrics::new(size, size * 1.2);
        let mut buffer = cosmic_text::Buffer::new(font_system, metrics);
        let mut buffer_borrow = buffer.borrow_with(font_system);
        buffer_borrow.set_size(Some(max_w), None);
        let mut attrs = cosmic_text::Attrs::new()
            .family(cosmic_text::Family::Name(family))
            .weight(cosmic_text::Weight(weight));
        // SansSerif fallback if the named family isn't present
        attrs = attrs.family(cosmic_text::Family::SansSerif);
        buffer_borrow.set_text(text, attrs, cosmic_text::Shaping::Advanced);
        buffer_borrow.shape_until_scroll(true);
        rasterize_buffer(pixmap, font_system, swash, &buffer, x, y, color);
    }

    fn draw_text_wrapped(
        pixmap: &mut tiny_skia::Pixmap,
        font_system: &mut cosmic_text::FontSystem,
        swash: &mut cosmic_text::SwashCache,
        text: &str,
        family: &str,
        size: f32,
        weight: u16,
        color: cosmic_text::Color,
        x: f32, y: f32, max_w: f32,
    ) {
        // Same as draw_text but multi-line via cosmic-text's natural wrap.
        let metrics = cosmic_text::Metrics::new(size, size * 1.35);
        let mut buffer = cosmic_text::Buffer::new(font_system, metrics);
        let mut buffer_borrow = buffer.borrow_with(font_system);
        buffer_borrow.set_size(Some(max_w), None);
        let mut attrs = cosmic_text::Attrs::new()
            .family(cosmic_text::Family::Name(family))
            .weight(cosmic_text::Weight(weight));
        attrs = attrs.family(cosmic_text::Family::SansSerif);
        buffer_borrow.set_text(text, attrs, cosmic_text::Shaping::Advanced);
        buffer_borrow.shape_until_scroll(true);
        rasterize_buffer(pixmap, font_system, swash, &buffer, x, y, color);
    }

    fn rasterize_buffer(
        pixmap: &mut tiny_skia::Pixmap,
        font_system: &mut cosmic_text::FontSystem,
        swash: &mut cosmic_text::SwashCache,
        buffer: &cosmic_text::Buffer,
        ox: f32, oy: f32,
        color: cosmic_text::Color,
    ) {
        buffer.draw(font_system, swash, color, |gx, gy, _gw, _gh, c| {
            let px = (ox as i32) + gx;
            let py = (oy as i32) + gy;
            if px < 0 || py < 0 || px >= pixmap.width() as i32 || py >= pixmap.height() as i32 {
                return;
            }
            let alpha = c.a();
            if alpha == 0 { return; }
            let idx = ((py as u32) * pixmap.width() + px as u32) as usize * 4;
            let pixmap_data = pixmap.data_mut();
            // Premultiplied alpha blend src over dst (same convention skia uses)
            let src_r = c.r();
            let src_g = c.g();
            let src_b = c.b();
            let dst_r = pixmap_data[idx + 0];
            let dst_g = pixmap_data[idx + 1];
            let dst_b = pixmap_data[idx + 2];
            let dst_a = pixmap_data[idx + 3];
            let inv_a = 255 - alpha as u16;
            pixmap_data[idx + 0] = ((src_r as u16 * alpha as u16 + dst_r as u16 * inv_a) / 255) as u8;
            pixmap_data[idx + 1] = ((src_g as u16 * alpha as u16 + dst_g as u16 * inv_a) / 255) as u8;
            pixmap_data[idx + 2] = ((src_b as u16 * alpha as u16 + dst_b as u16 * inv_a) / 255) as u8;
            pixmap_data[idx + 3] = (alpha as u16 + (dst_a as u16 * inv_a) / 255).min(255) as u8;
        });
    }
}
