const fs = require("fs"),
  xcode = require("xcode");
const path = "ios/App/App.xcodeproj/project.pbxproj";
const p = xcode.project(path);
p.parseSync();
if (
  !Object.values(p.pbxNativeTargetSection()).some(
    (t) => t.name === '"ShareExtension"',
  )
) {
  const t = p.addTarget(
    "ShareExtension",
    "app_extension",
    "ShareExtension",
    "app.aibro.mobile.share",
  );
  p.addBuildPhase(
    ["ShareExtension/ShareViewController.swift"],
    "PBXSourcesBuildPhase",
    "Sources",
    t.uuid,
  );
  p.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", t.uuid);
  p.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", t.uuid);
}
for (const c of Object.values(p.pbxXCBuildConfigurationSection())) {
  if (!c.buildSettings) continue;
  const b = c.buildSettings;
  if (String(b.PRODUCT_BUNDLE_IDENTIFIER).includes("app.aibro.mobile")) {
    b.CODE_SIGN_ENTITLEMENTS =
      '"' +
      (String(b.PRODUCT_BUNDLE_IDENTIFIER).includes(".share")
        ? "ShareExtension/ShareExtension.entitlements"
        : "App/App.entitlements") +
      '"';
    b.IPHONEOS_DEPLOYMENT_TARGET = "16.0";
    b.SWIFT_VERSION = "5.0";
    b.CURRENT_PROJECT_VERSION = "1";
    b.MARKETING_VERSION = "0.1.0";
    b.CODE_SIGN_STYLE = "Automatic";
  }
  if (String(b.PRODUCT_BUNDLE_IDENTIFIER).includes(".share")) {
    b.APPLICATION_EXTENSION_API_ONLY = "YES";
    b.TARGETED_DEVICE_FAMILY = '"1,2"';
    b.INFOPLIST_FILE = '"ShareExtension/Info.plist"';
  }
}
fs.writeFileSync(path, p.writeSync());
