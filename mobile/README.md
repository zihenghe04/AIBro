# AI Bro mobile development preview

Download the [Android 0.4.9 APK](https://github.com/zihenghe04/AIBro/releases/download/v0.9.4/AI-Bro-0.4.9-android.apk) from the [AI Bro 0.9.4 release](https://github.com/zihenghe04/AIBro/releases/tag/v0.9.4). This is a debug-signed development preview, not a store release. Back up important data before updating.

Chat and speech connections have separate named API profiles. API keys stay in Android Keystore / iOS Keychain; ordinary workspace exports do not contain them. Optional encrypted connection sharing requires a compatible self-hosted server and explicit approval on the owning Mac. Claude Code login is a Mac-only official CLI integration, not a mobile OAuth or subscription transfer.

iOS source is included, but the latest iOS build and native acceptance are incomplete. Earlier Simulator installation and keyboard checks remain unresolved. No installable iPhone IPA or App Store release is provided.

## Build from source

Use Node.js and install dependencies in this directory:

```sh
npm ci
npm run android:sync
cd android
./gradlew assembleDebug
```

Android requires JDK 21 and a configured Android SDK (`ANDROID_HOME` or a local, untracked `android/local.properties`). For iOS, use Xcode on macOS:

```sh
npm ci
npm run ios:sync
./scripts/package-ios.sh archive
```

The unsigned archive is source/build output, not directly installable on an iPhone. Device signing and provisioning are separate steps. No signing keys, local SDK paths, QA credentials, or user data are included.

This directory intentionally imports shared modules from `../app/`; clone the whole repository, not only `mobile/`. `npm run build` regenerates web assets; Capacitor sync updates each native project. Dependencies and license information are in the package lock and [third-party notices](THIRD_PARTY_NOTICES.md).
