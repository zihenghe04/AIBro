// AI Bro native glass: Apple public AppKit APIs only, C Node-API ABI v8.
#import <AppKit/AppKit.h>
#include <node_api.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

API_AVAILABLE(macos(26.0))
@interface AIBroGlassView : NSGlassEffectView
@end
@implementation AIBroGlassView
- (NSView *)hitTest:(NSPoint)point { return nil; }
- (BOOL)acceptsFirstResponder { return NO; }
- (BOOL)mouseDownCanMoveWindow { return NO; }
@end

static NSMapTable<NSView *, NSMutableDictionary<NSString *, NSView *> *> *hosts;
struct Region { std::string id; double x, y, width, height, radius; bool clear; };
static napi_value Bool(napi_env env, bool value) { napi_value out; napi_get_boolean(env, value, &out); return out; }
static napi_value Number(napi_env env, size_t value) { napi_value out; napi_create_uint32(env, (uint32_t)value, &out); return out; }
static napi_value Fail(napi_env env, const char *message) { napi_throw_error(env, "NATIVE_GLASS_INVALID", message); return nullptr; }
static bool Supported() { if (@available(macOS 26.0, *)) return YES; return NO; }
static bool Numeric(napi_env env, napi_value obj, const char *name, double &out) {
  napi_value value; napi_valuetype type;
  if (napi_get_named_property(env, obj, name, &value) != napi_ok || napi_typeof(env, value, &type) != napi_ok || type != napi_number || napi_get_value_double(env, value, &out) != napi_ok) return false;
  return std::isfinite(out) && std::abs(out) <= 100000;
}
static bool String(napi_env env, napi_value obj, const char *name, std::string &out, size_t maximum) {
  napi_value value; napi_valuetype type; size_t length = 0;
  if (napi_get_named_property(env, obj, name, &value) != napi_ok || napi_typeof(env, value, &type) != napi_ok || type != napi_string || napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > maximum) return false;
  std::vector<char> bytes(length + 1);
  if (napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &length) != napi_ok) return false;
  out.assign(bytes.data(), length); return true;
}
static bool ReadRegions(napi_env env, napi_value value, std::vector<Region> &regions) {
  bool array = false; uint32_t length = 0;
  if (napi_is_array(env, value, &array) != napi_ok || !array || napi_get_array_length(env, value, &length) != napi_ok || length > 16) return false;
  for (uint32_t i = 0; i < length; i++) {
    napi_value obj; Region r; std::string style;
    if (napi_get_element(env, value, i, &obj) != napi_ok || !String(env, obj, "id", r.id, 64) || r.id.empty() || !String(env, obj, "style", style, 7)) return false;
    for (char c : r.id) if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) return false;
    if (std::any_of(regions.begin(), regions.end(), [&](const Region &v) { return v.id == r.id; })) return false;
    if (!Numeric(env,obj,"x",r.x) || !Numeric(env,obj,"y",r.y) || !Numeric(env,obj,"width",r.width) || !Numeric(env,obj,"height",r.height) || !Numeric(env,obj,"radius",r.radius)) return false;
    if (r.width <= 0 || r.height <= 0 || r.radius < 0 || (style != "regular" && style != "clear")) return false;
    r.clear = style == "clear"; regions.push_back(r);
  }
  return true;
}
// Validate the opaque pointer by comparing it to live AppKit views before
// dereferencing it. The renderer never receives or supplies this handle.
static NSView *FindView(NSView *view, void *pointer, size_t &budget, int depth) {
  if (!view || budget == 0 || depth > 24) return nil;
  budget--;
  if ((__bridge void *)view == pointer) return view;
  for (NSView *child in view.subviews) { NSView *found = FindView(child, pointer, budget, depth + 1); if (found) return found; }
  return nil;
}
static NSView *ReadHost(napi_env env, napi_value handle) {
  bool isBuffer = false; void *bytes = nullptr; size_t length = 0;
  if (napi_is_buffer(env, handle, &isBuffer) != napi_ok || !isBuffer || napi_get_buffer_info(env, handle, &bytes, &length) != napi_ok || length != sizeof(void *)) return nil;
  void *pointer = nullptr; std::memcpy(&pointer, bytes, sizeof(pointer));
  if (!pointer || !NSApp) return nil;
  size_t budget = 4096;
  for (NSWindow *window in NSApp.windows) { NSView *found = FindView(window.contentView, pointer, budget, 0); if (found) return found; }
  return nil;
}
static void ClearHost(NSView *host) {
  NSMutableDictionary *views = [hosts objectForKey:host];
  for (NSView *view in views.allValues) [view removeFromSuperview];
  [hosts removeObjectForKey:host];
}
static void ClearAll() {
  NSArray *all = hosts.keyEnumerator.allObjects;
  for (NSView *host in all) ClearHost(host);
}
static napi_value IsSupported(napi_env env, napi_callback_info info) { return Bool(env, Supported()); }
static napi_value SetRegions(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2 || ![NSThread isMainThread]) return Fail(env, "Glass requires a main-thread window and region array.");
  std::vector<Region> regions;
  if (!ReadRegions(env, args[1], regions)) return Fail(env, "Invalid native glass regions.");
  if (!Supported()) return Number(env, 0);
  NSView *host = ReadHost(env, args[0]); if (!host) return Fail(env, "Native window is no longer available.");
  @try {
    if (@available(macOS 26.0, *)) {
      if (!hosts) hosts = [NSMapTable weakToStrongObjectsMapTable];
      NSMutableDictionary<NSString *, NSView *> *views = [hosts objectForKey:host];
      if (!views) { views = [NSMutableDictionary dictionary]; [hosts setObject:views forKey:host]; }
      NSMutableSet<NSString *> *retained = [NSMutableSet set];
      const NSRect bounds = host.bounds;
      for (const Region &r : regions) {
        double left = std::max(0.0, r.x), top = std::max(0.0, r.y);
        double right = std::min((double)bounds.size.width, r.x + r.width), bottom = std::min((double)bounds.size.height, r.y + r.height);
        if (right <= left || bottom <= top) continue;
        NSString *key = [NSString stringWithUTF8String:r.id.c_str()];
        AIBroGlassView *glass = (AIBroGlassView *)views[key];
        if (!glass) {
          glass = [[AIBroGlassView alloc] initWithFrame:NSZeroRect];
          glass.autoresizingMask = NSViewNotSizable;
          glass.contentView = [[NSView alloc] initWithFrame:NSZeroRect];
          glass.tintColor = nil;
          [host addSubview:glass positioned:NSWindowBelow relativeTo:nil];
          views[key] = glass;
        }
        glass.frame = NSMakeRect(bounds.origin.x + left, bounds.origin.y + (host.isFlipped ? top : bounds.size.height - bottom), right - left, bottom - top);
        glass.cornerRadius = std::min(r.radius, std::min(right - left, bottom - top) / 2);
        glass.style = r.clear ? NSGlassEffectViewStyleClear : NSGlassEffectViewStyleRegular;
        glass.tintColor = nil;
        [retained addObject:key];
      }
      for (NSString *key in [views.allKeys copy]) if (![retained containsObject:key]) { [views[key] removeFromSuperview]; [views removeObjectForKey:key]; }
      if (!views.count) [hosts removeObjectForKey:host];
      return Number(env, views.count);
    }
  } @catch (NSException *exception) { ClearHost(host); return Fail(env, "Native glass could not be updated."); }
  return Number(env, 0);
}
static napi_value Clear(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return Fail(env, "Glass cleanup requires the main thread.");
  size_t argc = 1; napi_value arg; napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  @try {
    if (!argc) ClearAll();
    else { NSView *host = ReadHost(env, arg); if (host) ClearHost(host); }
  } @catch (NSException *exception) { return Fail(env, "Native glass could not be cleared."); }
  return Bool(env, true);
}
static void Cleanup(void *) { if ([NSThread isMainThread]) ClearAll(); }
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"isSupported",nullptr,IsSupported,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setRegions",nullptr,SetRegions,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"clear",nullptr,Clear,nullptr,nullptr,nullptr,napi_default,nullptr}
  };
  napi_define_properties(env, exports, 3, props); napi_add_env_cleanup_hook(env, Cleanup, nullptr); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
