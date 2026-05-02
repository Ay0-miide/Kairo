//! Native Syphon sender for KAIRO (macOS only).
//!
//! Publishes verse text frames to the Syphon network so any compatible app
//! (OBS Syphon plugin, ProPresenter, Resolume, MadMapper, etc.) can pick the
//! source up directly — no capture bridge, no hidden window.
//!
//! Mirrors the design of `ndi.rs`: a single Mutex-guarded handle owns the
//! Syphon server, the GL context, and the texture; commands serialize through
//! it. The framework itself is bundled at `Frameworks/Syphon.framework` and
//! linked at build time (see `build.rs`).

#![cfg(target_os = "macos")]
#![allow(non_upper_case_globals, non_snake_case)]

use std::ffi::CString;
use std::os::raw::{c_int, c_uint, c_void};
use std::sync::{Arc, Mutex, Once};

use objc2::encode::{Encode, Encoding, RefEncode};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObject};
use objc2::{msg_send, sel};
use objc2_foundation::{NSDictionary, NSString};

use cosmic_text::{Color as CtColor, FontSystem, SwashCache};
use tiny_skia::{Color as SkColor, Pixmap, Rect, Transform};

// ── Frame size ──────────────────────────────────────────────────────────
// 1280×720 — same as the NDI sender, gives receivers a familiar dimension.
const FRAME_W: u32 = 1280;
const FRAME_H: u32 = 720;

// ── CGL bindings ────────────────────────────────────────────────────────
// We only need a tiny subset of CGL to spin up an offscreen OpenGL context
// the Syphon server can publish from. Declared inline rather than pulling
// in a CGL crate just for these five functions.
type CGLContextObj = *mut c_void;
type CGLPixelFormatObj = *mut c_void;
type CGLPixelFormatAttribute = c_uint;
type CGLError = c_int;

#[link(name = "OpenGL", kind = "framework")]
extern "C" {
    fn CGLChoosePixelFormat(
        attribs: *const CGLPixelFormatAttribute,
        pix: *mut CGLPixelFormatObj,
        npix: *mut c_int,
    ) -> CGLError;
    fn CGLCreateContext(
        pix: CGLPixelFormatObj,
        share: CGLContextObj,
        ctx: *mut CGLContextObj,
    ) -> CGLError;
    fn CGLSetCurrentContext(ctx: CGLContextObj) -> CGLError;
    fn CGLDestroyPixelFormat(pix: CGLPixelFormatObj) -> CGLError;
    fn CGLDestroyContext(ctx: CGLContextObj) -> CGLError;
}

const kCGLPFAAccelerated: CGLPixelFormatAttribute = 73;
const kCGLPFAOpenGLProfile: CGLPixelFormatAttribute = 99;
const kCGLOGLPVersion_Legacy: CGLPixelFormatAttribute = 0x1000;
const kCGLPFADoubleBuffer: CGLPixelFormatAttribute = 5;

// dlsym for loading GL function pointers — preferred over creating a real
// CGL context just to query addresses. OpenGL.framework's symbols are in
// the global symbol table so RTLD_DEFAULT (null handle) resolves them.
#[link(name = "c")]
extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const i8) -> *mut c_void;
}

// ── NS geometry types (need stable ABI for objc2 calls) ─────────────────
// On 64-bit macOS NSRect/NSPoint/NSSize are typedef'd to CGRect/CGPoint/CGSize.
// We declare Encode manually so msg_send! can pass them by value to ObjC.
#[repr(C)]
#[derive(Copy, Clone, Default)]
pub struct NSPoint { pub x: f64, pub y: f64 }
#[repr(C)]
#[derive(Copy, Clone, Default)]
pub struct NSSize  { pub width: f64, pub height: f64 }
#[repr(C)]
#[derive(Copy, Clone, Default)]
pub struct NSRect  { pub origin: NSPoint, pub size: NSSize }

unsafe impl Encode for NSPoint {
    const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for NSSize {
    const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for NSRect {
    const ENCODING: Encoding = Encoding::Struct("CGRect", &[NSPoint::ENCODING, NSSize::ENCODING]);
}
unsafe impl RefEncode for NSPoint { const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING); }
unsafe impl RefEncode for NSSize  { const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING); }
unsafe impl RefEncode for NSRect  { const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING); }

// ── Handle ──────────────────────────────────────────────────────────────
pub struct SyphonHandle {
    server: Option<Retained<NSObject>>, // SyphonOpenGLServer instance
    ctx: CGLContextObj,
    pix: CGLPixelFormatObj,
    tex_id: u32,
    pixmap: Option<Pixmap>,
}

impl Default for SyphonHandle {
    fn default() -> Self {
        Self {
            server: None,
            ctx: std::ptr::null_mut(),
            pix: std::ptr::null_mut(),
            tex_id: 0,
            pixmap: None,
        }
    }
}

// SAFETY: We serialize all access through Mutex; the underlying CGL context
// and SyphonServer object are usable from any thread as long as we don't
// overlap GL calls. The Mutex enforces that.
unsafe impl Send for SyphonHandle {}

// ── Public API ──────────────────────────────────────────────────────────
pub fn is_syphon_available() -> bool {
    // The framework is statically linked; if we got this far the linker
    // already resolved against it. Belt-and-suspenders: confirm the class
    // is reachable via the Obj-C runtime.
    AnyClass::get("SyphonOpenGLServer").is_some()
}

pub fn start(source_name: &str, shared: Arc<Mutex<SyphonHandle>>) -> Result<(), String> {
    let mut h = shared.lock().map_err(|e| e.to_string())?;
    if h.server.is_some() {
        return Err("Syphon already running".into());
    }

    // 1. Create CGL context — accelerated, legacy GL profile, double-buffered.
    //    Legacy is enough for our 2D upload-and-publish flow and avoids the
    //    extra hoops Core Profile needs (VAOs, shaders) to draw a textured quad.
    let mut pix: CGLPixelFormatObj = std::ptr::null_mut();
    let mut npix: c_int = 0;
    let attrs: [CGLPixelFormatAttribute; 6] = [
        kCGLPFAAccelerated,
        kCGLPFAOpenGLProfile, kCGLOGLPVersion_Legacy,
        kCGLPFADoubleBuffer,
        0, 0, // null-terminated
    ];
    unsafe {
        let err = CGLChoosePixelFormat(attrs.as_ptr(), &mut pix, &mut npix);
        if err != 0 || pix.is_null() {
            return Err(format!("CGLChoosePixelFormat failed: {err}"));
        }
        let mut ctx: CGLContextObj = std::ptr::null_mut();
        let err = CGLCreateContext(pix, std::ptr::null_mut(), &mut ctx);
        if err != 0 || ctx.is_null() {
            CGLDestroyPixelFormat(pix);
            return Err(format!("CGLCreateContext failed: {err}"));
        }
        CGLSetCurrentContext(ctx);
        h.ctx = ctx;
        h.pix = pix;
    }

    // 2. Resolve GL function pointers once. Subsequent calls are no-ops.
    static GL_LOADED: Once = Once::new();
    GL_LOADED.call_once(|| unsafe {
        gl::load_with(|name| {
            let cs = CString::new(name).unwrap();
            dlsym(std::ptr::null_mut(), cs.as_ptr()) as *const _
        });
    });

    // 3. Create the texture Syphon will publish from. We re-upload pixels
    //    into it on every `update` instead of allocating per frame.
    unsafe {
        let mut tex: u32 = 0;
        gl::GenTextures(1, &mut tex);
        gl::BindTexture(gl::TEXTURE_2D, tex);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::LINEAR as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::LINEAR as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S,    gl::CLAMP_TO_EDGE as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T,    gl::CLAMP_TO_EDGE as i32);
        gl::TexImage2D(
            gl::TEXTURE_2D, 0, gl::RGBA as i32,
            FRAME_W as i32, FRAME_H as i32, 0,
            gl::RGBA, gl::UNSIGNED_BYTE, std::ptr::null(),
        );
        h.tex_id = tex;
    }

    // 4. Allocate a reusable tiny-skia pixmap.
    h.pixmap = Some(Pixmap::new(FRAME_W, FRAME_H).ok_or("pixmap alloc failed")?);

    // 5. Spin up SyphonOpenGLServer.
    unsafe {
        let cls = AnyClass::get("SyphonOpenGLServer")
            .ok_or("SyphonOpenGLServer class not found — is Syphon.framework linked?")?;
        let name = NSString::from_str(source_name);
        let alloc: *mut AnyObject = msg_send![cls, alloc];
        let server: *mut AnyObject = msg_send![
            alloc,
            initWithName: &*name,
            context: h.ctx,
            options: std::ptr::null::<NSDictionary<NSString, AnyObject>>(),
        ];
        if server.is_null() {
            return Err("SyphonOpenGLServer init returned nil".into());
        }
        h.server = Some(
            Retained::from_raw(server.cast::<NSObject>())
                .ok_or("Retained::from_raw failed")?,
        );
    }

    // 6. Push an initial blank frame so receivers see something on connect.
    drop(h);
    update("Nothing on display", "", shared)?;

    eprintln!("[Syphon] server '{}' broadcasting {}x{}", source_name, FRAME_W, FRAME_H);
    Ok(())
}

pub fn stop(shared: Arc<Mutex<SyphonHandle>>) -> Result<(), String> {
    let mut h = shared.lock().map_err(|e| e.to_string())?;
    if let Some(server) = h.server.take() {
        unsafe {
            let _: () = msg_send![&*server, stop];
        }
    }
    unsafe {
        if h.tex_id != 0 {
            gl::DeleteTextures(1, &h.tex_id);
            h.tex_id = 0;
        }
        if !h.ctx.is_null() {
            CGLSetCurrentContext(std::ptr::null_mut());
            CGLDestroyContext(h.ctx);
            h.ctx = std::ptr::null_mut();
        }
        if !h.pix.is_null() {
            CGLDestroyPixelFormat(h.pix);
            h.pix = std::ptr::null_mut();
        }
    }
    h.pixmap = None;
    Ok(())
}

pub fn update(verse: &str, reference: &str, shared: Arc<Mutex<SyphonHandle>>) -> Result<(), String> {
    let mut h = shared.lock().map_err(|e| e.to_string())?;
    if h.server.is_none() {
        return Ok(()); // not running — silent no-op so the JS side can fire safely
    }

    // Snapshot scalar fields up front so we can split the borrow between the
    // mutable pixmap (rendering) and the immutable server reference (publish).
    let ctx    = h.ctx;
    let tex_id = h.tex_id;

    // Render via tiny-skia + cosmic-text (same look as ndi.rs).
    let pixels_ptr = {
        let pixmap = h.pixmap.as_mut().ok_or("pixmap missing")?;
        render_frame(pixmap, verse, reference);
        pixmap.data().as_ptr()
    };

    unsafe {
        // Make our context current, push the bytes into the texture.
        CGLSetCurrentContext(ctx);
        gl::BindTexture(gl::TEXTURE_2D, tex_id);
        gl::TexSubImage2D(
            gl::TEXTURE_2D, 0, 0, 0,
            FRAME_W as i32, FRAME_H as i32,
            gl::RGBA, gl::UNSIGNED_BYTE,
            pixels_ptr as *const _,
        );
        gl::Flush();

        // Hand the texture to Syphon. Region == full texture; flipped=NO
        // because tiny-skia draws origin-top-left and that's what GL wants
        // when imageRegion matches textureDimensions exactly.
        let server = h.server.as_ref().unwrap();
        let region = NSRect {
            origin: NSPoint { x: 0.0, y: 0.0 },
            size: NSSize { width: FRAME_W as f64, height: FRAME_H as f64 },
        };
        let size = NSSize { width: FRAME_W as f64, height: FRAME_H as f64 };
        let _: () = msg_send![
            &**server,
            publishFrameTexture: tex_id,
            textureTarget: 0x0DE1u32, // GL_TEXTURE_2D
            imageRegion: region,
            textureDimensions: size,
            flipped: false,
        ];
    }
    Ok(())
}

// ── Frame renderer ──────────────────────────────────────────────────────
// Same visual style as the NDI sender: black background, lower-third band,
// red brand-colored reference, white verse text. Rendered fresh every
// `update`, but the pixmap allocation is reused.
fn render_frame(pixmap: &mut Pixmap, verse: &str, reference: &str) {
    pixmap.fill(SkColor::from_rgba8(0, 0, 0, 230));

    // Subtle bottom 38% darker band — lower-third look.
    let mut band_paint = tiny_skia::Paint::default();
    band_paint.set_color(SkColor::from_rgba8(10, 14, 20, 255));
    band_paint.anti_alias = false;
    let band_h = (FRAME_H as f32 * 0.38) as f32;
    if let Some(band) = Rect::from_xywh(0.0, FRAME_H as f32 - band_h, FRAME_W as f32, band_h) {
        pixmap.fill_rect(band, &band_paint, Transform::identity(), None);
    }

    let mut font_system = FontSystem::new();
    let mut swash_cache = SwashCache::new();

    if !reference.is_empty() {
        draw_text(
            pixmap, &mut font_system, &mut swash_cache,
            reference,
            28.0, 700,
            CtColor::rgb(232, 64, 74),
            72.0, FRAME_H as f32 - band_h + 32.0,
            FRAME_W as f32 - 144.0,
        );
    }
    if !verse.is_empty() {
        draw_text(
            pixmap, &mut font_system, &mut swash_cache,
            verse,
            40.0, 500,
            CtColor::rgb(255, 255, 255),
            72.0, FRAME_H as f32 - band_h + 90.0,
            FRAME_W as f32 - 144.0,
        );
    }
    // Note: Syphon publishes the texture as RGBA, and tiny-skia produces RGBA
    // premultiplied — receivers handle premul correctly. No byte swap needed
    // (unlike the NDI sender which uses BGRA).
}

fn draw_text(
    pixmap: &mut Pixmap,
    font_system: &mut FontSystem,
    swash_cache: &mut SwashCache,
    text: &str,
    size_px: f32,
    weight: u16,
    color: CtColor,
    x: f32, y: f32,
    max_w: f32,
) {
    use cosmic_text::{Attrs, Buffer, Family, Metrics, Shaping, Weight};

    let metrics = Metrics::new(size_px, size_px * 1.25);
    let mut buf = Buffer::new(font_system, metrics);
    buf.set_size(font_system, Some(max_w), Some(2_000.0));
    let attrs = Attrs::new().family(Family::SansSerif).weight(Weight(weight));
    buf.set_text(font_system, text, attrs, Shaping::Advanced);
    buf.shape_until_scroll(font_system, false);

    let pixels: &mut [u8] = pixmap.data_mut();
    let stride = (FRAME_W * 4) as usize;
    let r = color.r();
    let g = color.g();
    let b = color.b();

    buf.draw(font_system, swash_cache, color, |gx, gy, _w, _h, gc| {
        let px = (x as i32) + gx;
        let py = (y as i32) + gy;
        if px < 0 || py < 0 || px >= FRAME_W as i32 || py >= FRAME_H as i32 {
            return;
        }
        // Alpha blend the glyph onto the pixmap.
        let a = gc.a() as u32;
        if a == 0 { return; }
        let off = py as usize * stride + px as usize * 4;
        let dr = pixels[off    ] as u32;
        let dg = pixels[off + 1] as u32;
        let db = pixels[off + 2] as u32;
        let inv = 255 - a;
        pixels[off    ] = ((r as u32 * a + dr * inv) / 255) as u8;
        pixels[off + 1] = ((g as u32 * a + dg * inv) / 255) as u8;
        pixels[off + 2] = ((b as u32 * a + db * inv) / 255) as u8;
        pixels[off + 3] = 255;
    });
}

// silence unused-import warnings for `sel` if the macro path drifts
#[allow(dead_code)]
fn _keep_sel() { let _ = sel!(stop); }
