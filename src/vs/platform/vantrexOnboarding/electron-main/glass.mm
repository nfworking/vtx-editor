// Vantrex native glass: puts the system's own Liquid Glass (NSGlassEffectView, drawn by the system on the GPU with Metal)
// behind the web content of a window. A small N-API addon, so it loads into Electron's main process without a rebuild.
//
// Build: sh build-glass.sh   (arm64; needs the Xcode command line tools and any Node's headers)
#include <node_api.h>
#import <AppKit/AppKit.h>
#import <Metal/Metal.h>

static NSString *const kGlassId = @"vantrex-glass";

static bool NativeGlassAvailable() {
    if (@available(macOS 26.0, *)) {
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        return NSClassFromString(@"NSGlassEffectView") != nil && device != nil;
    }
    return false;
}

static napi_value MakeBool(napi_env env, bool value) {
    napi_value result;
    napi_get_boolean(env, value, &result);
    return result;
}

static bool GetDouble(napi_env env, napi_value object, const char *key, double *out) {
    napi_value value;
    if (napi_get_named_property(env, object, key, &value) != napi_ok) return false;
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
    return napi_get_value_double(env, value, out) == napi_ok;
}

static NSString *GetString(napi_env env, napi_value object, const char *key) {
    napi_value value;
    if (napi_get_named_property(env, object, key, &value) != napi_ok) return nil;
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return nil;
    char buffer[64];
    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, buffer, sizeof(buffer), &length) != napi_ok) return nil;
    return [[NSString alloc] initWithBytes:buffer length:length encoding:NSUTF8StringEncoding];
}

/// The NSWindow behind a BrowserWindow.getNativeWindowHandle() buffer.
static NSWindow *WindowFromHandle(napi_env env, napi_value handle) {
    void *data = nullptr;
    size_t length = 0;
    if (napi_get_buffer_info(env, handle, &data, &length) != napi_ok || length < sizeof(void *)) return nil;
    NSView *view = (__bridge NSView *)(*reinterpret_cast<void **>(data));
    return [view isKindOfClass:[NSView class]] ? view.window : nil;
}

// isSupported(): is native Liquid Glass available on this Mac (macOS 26 or later, with Metal)?
static napi_value IsSupported(napi_env env, napi_callback_info) {
    return MakeBool(env, NativeGlassAvailable());
}

// apply(handle, { style: 'clear' | 'regular', cornerRadius, tint: [r, g, b, a] | null, appearance: 'dark' | 'light' | '' })
static napi_value Apply(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 2 || !NativeGlassAvailable()) return MakeBool(env, false);

    NSWindow *window = WindowFromHandle(env, argv[0]);
    if (!window) return MakeBool(env, false);

    NSString *style = GetString(env, argv[1], "style");
    NSString *appearance = GetString(env, argv[1], "appearance");
    double radius = 0, r = 0, g = 0, b = 0, a = -1;
    GetDouble(env, argv[1], "cornerRadius", &radius);
    bool hasTint = GetDouble(env, argv[1], "tintA", &a) && a > 0;
    if (hasTint) { GetDouble(env, argv[1], "tintR", &r); GetDouble(env, argv[1], "tintG", &g); GetDouble(env, argv[1], "tintB", &b); }

    if (@available(macOS 26.0, *)) {
        NSView *content = window.contentView;
        NSGlassEffectView *glass = nil;
        for (NSView *sub in content.subviews) {
            if ([sub.identifier isEqualToString:kGlassId]) { glass = (NSGlassEffectView *)sub; break; }
        }
        if (!glass) {
            glass = [[NSGlassEffectView alloc] initWithFrame:content.bounds];
            glass.identifier = kGlassId;
            glass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
            [content addSubview:glass positioned:NSWindowBelow relativeTo:nil];
        }
        glass.style = [style isEqualToString:@"regular"] ? NSGlassEffectViewStyleRegular : NSGlassEffectViewStyleClear;
        glass.cornerRadius = radius;
        glass.tintColor = hasTint ? [NSColor colorWithSRGBRed:r green:g blue:b alpha:a] : nil;

        window.opaque = NO;
        window.backgroundColor = NSColor.clearColor;
        // The content view's own layer is painted with the window's background colour (opaque black for an editor window), and
        // sits behind the glass, so the glass would only ever see black. It has to be clear.
        content.wantsLayer = YES;
        content.layer.backgroundColor = NSColor.clearColor.CGColor;
        if ([appearance isEqualToString:@"dark"]) window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
        else if ([appearance isEqualToString:@"light"]) window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
        else window.appearance = nil;
        return MakeBool(env, true);
    }
    return MakeBool(env, false);
}

// remove(handle): takes the glass away again.
static napi_value Remove(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    NSWindow *window = argc > 0 ? WindowFromHandle(env, argv[0]) : nil;
    if (!window) return MakeBool(env, false);
    for (NSView *sub in [window.contentView.subviews copy]) {
        if ([sub.identifier isEqualToString:kGlassId]) [sub removeFromSuperview];
    }
    return MakeBool(env, true);
}

static void DescribeView(NSMutableString *text, NSView *view, int depth) {
    CGColorRef bg = view.layer.backgroundColor;
    NSString *bgText = bg ? [NSString stringWithFormat:@"%.2f", CGColorGetAlpha(bg)] : @"-";
    [text appendFormat:@"\n%*s%@ opaque=%d layerOpaque=%d bgAlpha=%@ alpha=%.2f hidden=%d frame=%@", depth * 2, "", NSStringFromClass([view class]), view.isOpaque, view.layer.isOpaque, bgText, view.alphaValue, view.isHidden, NSStringFromRect(view.frame)];
    if (depth < 4) for (NSView *sub in view.subviews) DescribeView(text, sub, depth + 1);
}

// describe(handle): what the window looks like, for debugging.
static napi_value Describe(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    NSWindow *window = argc > 0 ? WindowFromHandle(env, argv[0]) : nil;
    NSMutableString *text = [NSMutableString string];
    if (!window) {
        [text appendString:@"no window from handle"];
    } else {
        [text appendFormat:@"window opaque=%d style=%lu level=%ld", window.opaque, (unsigned long)window.styleMask, (long)window.level];
        DescribeView(text, window.contentView, 0);
    }
    napi_value result;
    napi_create_string_utf8(env, text.UTF8String, NAPI_AUTO_LENGTH, &result);
    return result;
}

static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor props[] = {
        { "isSupported", nullptr, IsSupported, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "apply", nullptr, Apply, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "remove", nullptr, Remove, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "describe", nullptr, Describe, nullptr, nullptr, nullptr, napi_default, nullptr },
    };
    napi_define_properties(env, exports, 4, props);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
