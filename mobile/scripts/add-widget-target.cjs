const fs = require('fs'), xcode = require('xcode');
const path = 'ios/App/App.xcodeproj/project.pbxproj', p = xcode.project(path); p.parseSync();
let target = Object.entries(p.pbxNativeTargetSection()).find(([k,t]) => !k.endsWith('_comment') && String(t.name).replaceAll('"','') === 'TodayWidget');
if (!target) {
  const t = p.addTarget('TodayWidget', 'app_extension', 'TodayWidget', 'app.aibro.mobile.widget');
  p.addBuildPhase(['TodayWidget/TodayWidget.swift'], 'PBXSourcesBuildPhase', 'Sources', t.uuid);
  p.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', t.uuid);
  p.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', t.uuid);
}
for (const c of Object.values(p.pbxXCBuildConfigurationSection())) {
  const b=c.buildSettings; if (!b || !String(b.PRODUCT_BUNDLE_IDENTIFIER).includes('app.aibro.mobile.widget')) continue;
  Object.assign(b, {CODE_SIGN_ENTITLEMENTS:'"TodayWidget/TodayWidget.entitlements"', IPHONEOS_DEPLOYMENT_TARGET:'16.0', SWIFT_VERSION:'5.0', CURRENT_PROJECT_VERSION:'1', MARKETING_VERSION:'0.1.0', CODE_SIGN_STYLE:'Automatic', APPLICATION_EXTENSION_API_ONLY:'YES', TARGETED_DEVICE_FAMILY:'"1,2"', INFOPLIST_FILE:'"TodayWidget/Info.plist"', SKIP_INSTALL:'YES'});
}
for (const ref of Object.values(p.pbxFileReferenceSection())) { if (ref.explicitFileType === 'undefined') delete ref.explicitFileType; }
fs.writeFileSync(path, p.writeSync());
