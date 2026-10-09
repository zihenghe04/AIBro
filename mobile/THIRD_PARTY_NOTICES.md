# Third-party notices

AI Bro Mobile is part of AI Bro, licensed under AGPL-3.0-only. See the repository LICENSE. The app's source, including these modifications, is available with the product source.

## UCAS course integration

`src/ucas.js` adapts the school API contracts and response interpretation reviewed in:

- **UCAS-Sign-in**, zhan-nine: https://github.com/zhan-nine/UCAS-Sign-in — GNU Affero General Public License v3.0.
- **UCAS-Course-Sign-in**, lccipher: https://github.com/lccipher/UCAS-Course-Sign-in — GNU Affero General Public License v3.0, credited by UCAS-Sign-in's NOTICE.

The mobile implementation uses a separate school session protected by the iOS Keychain or Android Keystore, explicit password login, course retrieval, timestamp validation and user-initiated attendance submission, explicit opt-in foreground attendance, course time selection and time-aligned QR generation. Reviewed upstream commit: `92dcea4d683603a57ac16d88c61bb0a05b20c6c8` (1.1.8, 2026-09-16). It does not incorporate the upstream Android service, identity-only login, or automatic background attendance scheduler. It is not an official UCAS client.

Upstream license and notice copies are retained under `native/licenses/ucas/`. Review the upstream distribution notices before redistributing any additional upstream assets or code.

## Dependencies

The mobile sync status uses the repository's existing audited Halaska UI bridge
(`app/halaska-ui.js`) and local Geist font (`app/halaska-geist.woff2`). The bridge
retains its full bundled third-party notices, including Halaska, React and font
licenses; it is emitted unchanged as an offline asset. The mobile-owned React
surface is in `src/ui/`. No CDN fonts or UI scripts are loaded. Source and the
pinned integration are retained in `app/ui/` and
[`docs/HALASKA_KIT_INTEGRATION_20260924.md`](../docs/HALASKA_KIT_INTEGRATION_20260924.md).

Runtime and build dependencies are pinned in `package-lock.json`; Swift package resolution is retained in the Xcode project. Their original license files are included in their packages:

- Capacitor and official Capacitor plugins — MIT.
- Vite — MIT.
- Marked — MIT; DOMPurify — Apache-2.0 OR MPL-2.0.
- ical.js — MPL-2.0.
- @js-temporal/polyfill — ISC; JSBI — Apache-2.0 (time zone and recurrence arithmetic).
- jsdiff — BSD-3-Clause.
- qrcode — MIT.
- fflate — MIT.
- PDF.js (pdfjs-dist) — Apache-2.0; browser-local PDF text extraction.
- node-xcode (project setup utility) — Apache-2.0.
- Playwright (development tests) — Apache-2.0.

## Android native dependencies

The Android additions are pinned in `android/app/build.gradle`. The declarations below follow the resolved Maven POM files. Original POM copies, their source URLs and SHA-256 hashes are retained in [maven-license-evidence.json](native/licenses/android/maven-license-evidence.json).

| Maven coordinate | License declared by the POM | Source |
| --- | --- | --- |
| `com.tom-roush:pdfbox-android:2.0.27.0` | The Apache Software License, Version 2.0 — `http://www.apache.org/licenses/LICENSE-2.0.txt` | [PDFBox Android v2.0.27.0](https://github.com/TomRoush/PdfBox-Android/tree/v2.0.27.0); [retained POM](native/licenses/android/pdfbox-android-2.0.27.0/pdfbox-android-2.0.27.0.pom) |
| `com.squareup.okhttp3:okhttp:4.12.0` | The Apache Software License, Version 2.0 — `http://www.apache.org/licenses/LICENSE-2.0.txt` | [OkHttp 4.12.0](https://github.com/square/okhttp/tree/parent-4.12.0); [retained POM](native/licenses/android/okhttp-4.12.0/okhttp-4.12.0.pom) |
| `com.google.mlkit:text-recognition-chinese:16.0.1` | [ML Kit Terms of Service](https://developers.google.com/ml-kit/terms) | [ML Kit text recognition](https://developers.google.com/ml-kit/vision/text-recognition/v2/android); [retained POM](native/licenses/android/text-recognition-chinese-16.0.1/text-recognition-chinese-16.0.1.pom) |
| `androidx.exifinterface:exifinterface:1.4.1` | The Apache Software License, Version 2.0 — `http://www.apache.org/licenses/LICENSE-2.0.txt` | [AndroidX ExifInterface](https://developer.android.com/jetpack/androidx/releases/exifinterface); [retained POM](native/licenses/android/exifinterface-1.4.1/exifinterface-1.4.1.pom) |

The PDFBox Android [LICENSE.txt](native/licenses/android/pdfbox-android-2.0.27.0/LICENSE.txt) and [NOTICE.txt](native/licenses/android/pdfbox-android-2.0.27.0/NOTICE.txt) are retained in full from the matching upstream tag. The license file includes notices for its PDFBox/FontBox, font and other external components.

The OkHttp [LICENSE.txt](native/licenses/android/okhttp-4.12.0/LICENSE.txt) is retained from the matching upstream tag. Its JAR also includes a [Public Suffix List notice](native/licenses/android/okhttp-4.12.0/publicsuffix-NOTICE.txt), which identifies `publicsuffixes.gz` as MPL-2.0 data.

The ML Kit SDK is governed by the ML Kit Terms of Service named in its POM. Its bundled components also carry third-party notices. Both original AAR files, [third_party_licenses.json](native/licenses/android/text-recognition-chinese-16.0.1/third_party_licenses.json) and [third_party_licenses.txt](native/licenses/android/text-recognition-chinese-16.0.1/third_party_licenses.txt), are retained without modification. These component notices do not replace the SDK's own terms.
